#pragma once

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct MonitorItem {
    int index;
    std::wstring name;
    int width;
    int height;
    bool primary;
};

struct VideoSharedHeader {
    uint32_t frameSeq;
    uint32_t activeSlot;
    uint32_t width;
    uint32_t height;
    uint32_t stride;
    uint32_t byteSize;
    uint32_t format; // 1 = NV12, 2 = BGRA
    uint32_t reserved;
};

class DxgiCaptureService {
public:
    static constexpr uint32_t HeaderBytes = 64;
    static constexpr uint32_t SlotMaxBytes = 13'000'000; // Fits up to 3840x2160 NV12 (~12.44 MB) or 1920x1080 BGRA (~8.3 MB)
    static constexpr uint64_t SharedBufferTotalBytes = HeaderBytes + (2ULL * SlotMaxBytes);

    static constexpr uint32_t FormatNV12 = 1;
    static constexpr uint32_t FormatBGRA = 2;

    explicit DxgiCaptureService(uint8_t* sharedPtr)
        : m_sharedPtr(sharedPtr) {
        if (m_sharedPtr) {
            std::memset(m_sharedPtr, 0, HeaderBytes);
        }
    }

    ~DxgiCaptureService() {
        Stop();
    }

    static std::vector<MonitorItem> ListMonitors() {
        std::vector<MonitorItem> list;
        Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
        if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf())))) {
            return list;
        }

        int globalIdx = 0;
        for (UINT a = 0;; ++a) {
            Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;

            DXGI_ADAPTER_DESC1 adesc{};
            adapter->GetDesc1(&adesc);
            if (adesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;

            for (UINT o = 0;; ++o) {
                Microsoft::WRL::ComPtr<IDXGIOutput> output;
                if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;

                DXGI_OUTPUT_DESC odesc{};
                if (SUCCEEDED(output->GetDesc(&odesc)) && odesc.AttachedToDesktop) {
                    int w = odesc.DesktopCoordinates.right - odesc.DesktopCoordinates.left;
                    int h = odesc.DesktopCoordinates.bottom - odesc.DesktopCoordinates.top;
                    bool primary = (odesc.DesktopCoordinates.left == 0 && odesc.DesktopCoordinates.top == 0);

                    std::wstring label = L"Monitor " + std::to_wstring(globalIdx + 1) +
                                         L" (" + std::to_wstring(w) + L"x" + std::to_wstring(h) + L")";
                    if (primary) label += L" — Principal";
                    list.push_back({globalIdx, label, w, h, primary});
                    ++globalIdx;
                }
            }
        }
        return list;
    }

    bool Start(int monitorIndex, int targetMaxWidth, int targetMaxHeight, int fps) {
        std::lock_guard<std::mutex> lock(m_mutex);
        StopUnlocked();

        m_monitorIndex = std::max(0, monitorIndex);
        m_targetMaxW.store(std::max(0, targetMaxWidth));
        m_targetMaxH.store(std::max(0, targetMaxHeight));
        m_fps.store(std::clamp(fps, 15, 60));

        if (!m_sharedPtr) return false;
        std::memset(m_sharedPtr, 0, HeaderBytes);

        m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        m_worker = std::thread([this]() {
            CaptureThread();
        });
        return true;
    }

    void UpdateSettings(int targetMaxWidth, int targetMaxHeight, int fps) {
        m_targetMaxW.store(std::max(0, targetMaxWidth));
        m_targetMaxH.store(std::max(0, targetMaxHeight));
        m_fps.store(std::clamp(fps, 15, 60));
    }

    void Stop() {
        std::lock_guard<std::mutex> lock(m_mutex);
        StopUnlocked();
    }

private:
    void StopUnlocked() {
        if (m_stopEvent) SetEvent(m_stopEvent);
        if (m_worker.joinable()) m_worker.join();
        if (m_stopEvent) {
            CloseHandle(m_stopEvent);
            m_stopEvent = nullptr;
        }
    }

    struct DxgiContext {
        Microsoft::WRL::ComPtr<ID3D11Device> device;
        Microsoft::WRL::ComPtr<ID3D11DeviceContext> ctx;
        Microsoft::WRL::ComPtr<IDXGIOutputDuplication> dupl;
        Microsoft::WRL::ComPtr<ID3D11VideoDevice> videoDev;
        Microsoft::WRL::ComPtr<ID3D11VideoContext> videoCtx;
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> vpEnum;
        Microsoft::WRL::ComPtr<ID3D11VideoProcessor> vp;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> inCopyTex;
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView> vpInView;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> outTex;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTex;
        Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> vpOutView;

        uint32_t srcW = 0;
        uint32_t srcH = 0;
        uint32_t dstW = 0;
        uint32_t dstH = 0;
        uint32_t outFormat = FormatNV12;
        bool hasLastFrame = false;

        void ResetPipeline() {
            vpInView.Reset();
            inCopyTex.Reset();
            vpOutView.Reset();
            stagingTex.Reset();
            outTex.Reset();
            vp.Reset();
            vpEnum.Reset();
        }

        void ResetAll() {
            ResetPipeline();
            dupl.Reset();
            videoCtx.Reset();
            videoDev.Reset();
            ctx.Reset();
            device.Reset();
            hasLastFrame = false;
        }
    };

    static void AttachToInputDesktop() {
        HDESK hDesk = OpenInputDesktop(0, FALSE, DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | GENERIC_READ);
        if (hDesk) {
            SetThreadDesktop(hDesk);
            CloseDesktop(hDesk);
        }
    }

    static bool CreateDuplicationForMonitor(int monitorIdx, DxgiContext& dc) {
        dc.ResetAll();
        AttachToInputDesktop();

        Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
        if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), reinterpret_cast<void**>(factory.GetAddressOf())))) {
            return false;
        }

        Microsoft::WRL::ComPtr<IDXGIAdapter1> targetAdapter;
        Microsoft::WRL::ComPtr<IDXGIOutput> targetOutput;
        int curIdx = 0;

        for (UINT a = 0;; ++a) {
            Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
            if (factory->EnumAdapters1(a, &adapter) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_ADAPTER_DESC1 adesc{};
            adapter->GetDesc1(&adesc);
            if (adesc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) continue;

            for (UINT o = 0;; ++o) {
                Microsoft::WRL::ComPtr<IDXGIOutput> output;
                if (adapter->EnumOutputs(o, &output) == DXGI_ERROR_NOT_FOUND) break;
                DXGI_OUTPUT_DESC odesc{};
                if (SUCCEEDED(output->GetDesc(&odesc)) && odesc.AttachedToDesktop) {
                    if (curIdx == monitorIdx) {
                        targetAdapter = adapter;
                        targetOutput = output;
                        break;
                    }
                    ++curIdx;
                }
            }
            if (targetOutput) break;
        }

        // Fallback to monitor 0 if requested index vanished
        if (!targetOutput && monitorIdx != 0) {
            return CreateDuplicationForMonitor(0, dc);
        }
        if (!targetAdapter || !targetOutput) return false;

        D3D_FEATURE_LEVEL flOut{};
        UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0};
        HRESULT hr = D3D11CreateDevice(
            targetAdapter.Get(),
            D3D_DRIVER_TYPE_UNKNOWN,
            nullptr,
            flags,
            levels,
            2,
            D3D11_SDK_VERSION,
            &dc.device,
            &flOut,
            &dc.ctx);
        if (FAILED(hr) || !dc.device) return false;

        Microsoft::WRL::ComPtr<IDXGIOutput1> output1;
        if (FAILED(targetOutput.As(&output1)) || !output1) return false;

        hr = output1->DuplicateOutput(dc.device.Get(), &dc.dupl);
        if (FAILED(hr) || !dc.dupl) return false;

        DXGI_OUTDUPL_DESC ddesc{};
        dc.dupl->GetDesc(&ddesc);
        dc.srcW = ddesc.ModeDesc.Width;
        dc.srcH = ddesc.ModeDesc.Height;

        dc.device.As(&dc.videoDev);
        dc.ctx.As(&dc.videoCtx);
        return dc.srcW > 0 && dc.srcH > 0;
    }

    static void ComputeTargetSize(uint32_t srcW, uint32_t srcH, int maxW, int maxH, uint32_t& outW, uint32_t& outH) {
        if (maxW <= 0 || maxH <= 0 || (srcW <= static_cast<uint32_t>(maxW) && srcH <= static_cast<uint32_t>(maxH))) {
            outW = srcW;
            outH = srcH;
        } else {
            double sx = static_cast<double>(maxW) / srcW;
            double sy = static_cast<double>(maxH) / srcH;
            double scale = std::min(sx, sy);
            outW = static_cast<uint32_t>(srcW * scale);
            outH = static_cast<uint32_t>(srcH * scale);
        }
        // NV12 requires even dimensions; cap to fit safely inside SlotMaxBytes
        outW &= ~1u;
        outH &= ~1u;
        if (outW < 320) outW = 320;
        if (outH < 180) outH = 180;
    }

    static bool EnsurePipeline(DxgiContext& dc, uint32_t dstW, uint32_t dstH) {
        if (dc.vp && dc.stagingTex && dc.dstW == dstW && dc.dstH == dstH) {
            return true;
        }
        dc.ResetPipeline();
        dc.dstW = dstW;
        dc.dstH = dstH;

        // Try GPU NV12 conversion + downscaling via ID3D11VideoProcessor first (tiny memory footprint!)
        if (dc.videoDev && dc.videoCtx && (static_cast<uint64_t>(dstW) * dstH * 3 / 2) <= SlotMaxBytes) {
            D3D11_VIDEO_PROCESSOR_CONTENT_DESC content{};
            content.InputFrameFormat = D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE;
            content.InputWidth = dc.srcW;
            content.InputHeight = dc.srcH;
            content.OutputWidth = dstW;
            content.OutputHeight = dstH;
            content.Usage = D3D11_VIDEO_USAGE_OPTIMAL_SPEED;

            if (SUCCEEDED(dc.videoDev->CreateVideoProcessorEnumerator(&content, &dc.vpEnum)) &&
                dc.vpEnum &&
                SUCCEEDED(dc.videoDev->CreateVideoProcessor(dc.vpEnum.Get(), 0, &dc.vp)) &&
                dc.vp) {

                D3D11_TEXTURE2D_DESC inDesc{};
                inDesc.Width = dc.srcW;
                inDesc.Height = dc.srcH;
                inDesc.MipLevels = 1;
                inDesc.ArraySize = 1;
                inDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
                inDesc.SampleDesc.Count = 1;
                inDesc.Usage = D3D11_USAGE_DEFAULT;
                inDesc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;

                D3D11_TEXTURE2D_DESC outDesc{};
                outDesc.Width = dstW;
                outDesc.Height = dstH;
                outDesc.MipLevels = 1;
                outDesc.ArraySize = 1;
                outDesc.Format = DXGI_FORMAT_NV12;
                outDesc.SampleDesc.Count = 1;
                outDesc.Usage = D3D11_USAGE_DEFAULT;
                outDesc.BindFlags = D3D11_BIND_RENDER_TARGET;

                D3D11_TEXTURE2D_DESC stgDesc = outDesc;
                stgDesc.Usage = D3D11_USAGE_STAGING;
                stgDesc.BindFlags = 0;
                stgDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;

                if (SUCCEEDED(dc.device->CreateTexture2D(&inDesc, nullptr, &dc.inCopyTex)) &&
                    SUCCEEDED(dc.device->CreateTexture2D(&outDesc, nullptr, &dc.outTex)) &&
                    SUCCEEDED(dc.device->CreateTexture2D(&stgDesc, nullptr, &dc.stagingTex))) {

                    D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivDesc{};
                    ivDesc.ViewDimension = D3D11_VPIV_DIMENSION_TEXTURE2D;
                    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovDesc{};
                    ovDesc.ViewDimension = D3D11_VPOV_DIMENSION_TEXTURE2D;

                    if (SUCCEEDED(dc.videoDev->CreateVideoProcessorInputView(dc.inCopyTex.Get(), dc.vpEnum.Get(), &ivDesc, &dc.vpInView)) &&
                        SUCCEEDED(dc.videoDev->CreateVideoProcessorOutputView(dc.outTex.Get(), dc.vpEnum.Get(), &ovDesc, &dc.vpOutView))) {
                        RECT srcRect{0, 0, static_cast<LONG>(dc.srcW), static_cast<LONG>(dc.srcH)};
                        RECT dstRect{0, 0, static_cast<LONG>(dstW), static_cast<LONG>(dstH)};
                        dc.videoCtx->VideoProcessorSetStreamSourceRect(dc.vp.Get(), 0, TRUE, &srcRect);
                        dc.videoCtx->VideoProcessorSetStreamDestRect(dc.vp.Get(), 0, TRUE, &dstRect);
                        dc.videoCtx->VideoProcessorSetOutputTargetRect(dc.vp.Get(), TRUE, &dstRect);
                        dc.outFormat = FormatNV12;
                        return true;
                    }
                }
            }
            dc.ResetPipeline();
        }

        // Fallback: native BGRA staging texture (if same dimensions or VideoProcessor unavailable)
        uint32_t bgraW = dc.srcW;
        uint32_t bgraH = dc.srcH;
        if (static_cast<uint64_t>(bgraW) * bgraH * 4 > SlotMaxBytes) {
            return false;
        }
        D3D11_TEXTURE2D_DESC stgDesc{};
        stgDesc.Width = bgraW;
        stgDesc.Height = bgraH;
        stgDesc.MipLevels = 1;
        stgDesc.ArraySize = 1;
        stgDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        stgDesc.SampleDesc.Count = 1;
        stgDesc.Usage = D3D11_USAGE_STAGING;
        stgDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        if (FAILED(dc.device->CreateTexture2D(&stgDesc, nullptr, &dc.stagingTex))) {
            return false;
        }
        dc.dstW = bgraW;
        dc.dstH = bgraH;
        dc.outFormat = FormatBGRA;
        return true;
    }

    void PublishStagingToShared(DxgiContext& dc) {
        if (!dc.stagingTex || !m_sharedPtr) return;

        D3D11_MAPPED_SUBRESOURCE mapped{};
        if (FAILED(dc.ctx->Map(dc.stagingTex.Get(), 0, D3D11_MAP_READ, 0, &mapped))) {
            return;
        }

        uint32_t nextSlot = (m_activeSlot ^ 1u) & 1u;
        uint8_t* dstPtr = m_sharedPtr + HeaderBytes + (static_cast<size_t>(nextSlot) * SlotMaxBytes);
        uint32_t byteSize = 0;

        if (dc.outFormat == FormatNV12) {
            // Copy compact Y plane (dstH rows of dstW bytes) followed by UV plane (dstH/2 rows of dstW bytes)
            const uint8_t* srcY = static_cast<const uint8_t*>(mapped.pData);
            for (uint32_t row = 0; row < dc.dstH; ++row) {
                std::memcpy(dstPtr + (row * dc.dstW), srcY + (row * mapped.RowPitch), dc.dstW);
            }
            const uint8_t* srcUV = srcY + (dc.dstH * mapped.RowPitch);
            uint8_t* dstUV = dstPtr + (dc.dstH * dc.dstW);
            uint32_t uvRows = dc.dstH / 2;
            for (uint32_t row = 0; row < uvRows; ++row) {
                std::memcpy(dstUV + (row * dc.dstW), srcUV + (row * mapped.RowPitch), dc.dstW);
            }
            byteSize = dc.dstW * dc.dstH * 3 / 2;
        } else {
            uint32_t rowBytes = dc.dstW * 4;
            const uint8_t* src = static_cast<const uint8_t*>(mapped.pData);
            for (uint32_t row = 0; row < dc.dstH; ++row) {
                std::memcpy(dstPtr + (row * rowBytes), src + (row * mapped.RowPitch), rowBytes);
            }
            byteSize = rowBytes * dc.dstH;
        }

        dc.ctx->Unmap(dc.stagingTex.Get(), 0);

        m_activeSlot = nextSlot;
        ++m_frameSeq;

        auto* hdr = reinterpret_cast<volatile VideoSharedHeader*>(m_sharedPtr);
        hdr->activeSlot = nextSlot;
        hdr->width = dc.dstW;
        hdr->height = dc.dstH;
        hdr->stride = (dc.outFormat == FormatNV12) ? dc.dstW : (dc.dstW * 4);
        hdr->byteSize = byteSize;
        hdr->format = dc.outFormat;
        MemoryBarrier();
        InterlockedExchange(reinterpret_cast<volatile LONG*>(&hdr->frameSeq), static_cast<LONG>(m_frameSeq));
    }

    void CaptureThread() {
        DxgiContext dc;
        bool ready = CreateDuplicationForMonitor(m_monitorIndex, dc);

        while (WaitForSingleObject(m_stopEvent, 0) == WAIT_TIMEOUT) {
            auto frameStart = std::chrono::steady_clock::now();
            int targetFps = m_fps.load();
            auto framePeriod = std::chrono::microseconds(1'000'000 / std::max(15, targetFps));

            if (!ready) {
                if (WaitForSingleObject(m_stopEvent, 120) == WAIT_OBJECT_0) break;
                ready = CreateDuplicationForMonitor(m_monitorIndex, dc);
                continue;
            }

            uint32_t dstW = 0, dstH = 0;
            ComputeTargetSize(dc.srcW, dc.srcH, m_targetMaxW.load(), m_targetMaxH.load(), dstW, dstH);
            if (!EnsurePipeline(dc, dstW, dstH)) {
                if (WaitForSingleObject(m_stopEvent, 120) == WAIT_OBJECT_0) break;
                ready = false;
                continue;
            }

            DXGI_OUTDUPL_FRAME_INFO info{};
            Microsoft::WRL::ComPtr<IDXGIResource> res;
            HRESULT hr = dc.dupl->AcquireNextFrame(8, &info, &res);

            if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
                // Fullscreen game switched display mode / Exclusive Flip! Reacquire immediately.
                ready = false;
                continue;
            }

            if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
                // Screen didn't change this tick; keep stream alive if we haven't emitted in a bit
            } else if (SUCCEEDED(hr) && res) {
                Microsoft::WRL::ComPtr<ID3D11Texture2D> acquiredTex;
                if (SUCCEEDED(res.As(&acquiredTex)) && acquiredTex) {
                    if (dc.outFormat == FormatNV12 && dc.vp && dc.vpInView && dc.vpOutView && dc.inCopyTex) {
                        dc.ctx->CopyResource(dc.inCopyTex.Get(), acquiredTex.Get());
                        D3D11_VIDEO_PROCESSOR_STREAM stream{};
                        stream.Enable = TRUE;
                        stream.pInputSurface = dc.vpInView.Get();
                        if (SUCCEEDED(dc.videoCtx->VideoProcessorBlt(dc.vp.Get(), dc.vpOutView.Get(), 0, 1, &stream))) {
                            dc.ctx->CopyResource(dc.stagingTex.Get(), dc.outTex.Get());
                            dc.hasLastFrame = true;
                        }
                    } else {
                        dc.ctx->CopyResource(dc.stagingTex.Get(), acquiredTex.Get());
                        dc.hasLastFrame = true;
                    }
                }
                dc.dupl->ReleaseFrame();

                if (dc.hasLastFrame) {
                    PublishStagingToShared(dc);
                }
            }

            auto elapsed = std::chrono::steady_clock::now() - frameStart;
            if (elapsed < framePeriod) {
                auto remMs = std::chrono::duration_cast<std::chrono::milliseconds>(framePeriod - elapsed).count();
                if (remMs > 0) {
                    if (WaitForSingleObject(m_stopEvent, static_cast<DWORD>(remMs)) == WAIT_OBJECT_0) break;
                }
            }
        }

        dc.ResetAll();
    }

    uint8_t* m_sharedPtr = nullptr;
    std::mutex m_mutex;
    std::thread m_worker;
    HANDLE m_stopEvent = nullptr;

    int m_monitorIndex = 0;
    std::atomic<int> m_targetMaxW{1920};
    std::atomic<int> m_targetMaxH{1080};
    std::atomic<int> m_fps{60};

    uint32_t m_activeSlot = 0;
    uint32_t m_frameSeq = 0;
};
