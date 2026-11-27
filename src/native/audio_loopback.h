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
#include <objbase.h>
#include <tlhelp32.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <avrt.h>
#include <wrl.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <vector>

#ifndef AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
#define AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM 0x80000000
#endif
#ifndef AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
#define AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY 0x08000000
#endif

struct AudioAppItem {
    DWORD pid;
    std::wstring name;
    std::wstring title;
};

namespace detail {

inline std::wstring StripExeSuffix(const std::wstring& exe) {
    if (exe.size() > 4) {
        std::wstring tail = exe.substr(exe.size() - 4);
        if (_wcsicmp(tail.c_str(), L".exe") == 0) {
            return exe.substr(0, exe.size() - 4);
        }
    }
    return exe;
}

inline bool IsDiscordExeName(const std::wstring& exe) {
    return _wcsicmp(exe.c_str(), L"Discord.exe") == 0 ||
           _wcsicmp(exe.c_str(), L"DiscordPTB.exe") == 0 ||
           _wcsicmp(exe.c_str(), L"DiscordCanary.exe") == 0;
}

inline uint64_t GetProcessStartTicks(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return UINT64_MAX;
    FILETIME createFt{}, exitFt{}, kernelFt{}, userFt{};
    uint64_t out = UINT64_MAX;
    if (GetProcessTimes(h, &createFt, &exitFt, &kernelFt, &userFt)) {
        ULARGE_INTEGER u{};
        u.LowPart = createFt.dwLowDateTime;
        u.HighPart = createFt.dwHighDateTime;
        out = u.QuadPart;
    }
    CloseHandle(h);
    return out;
}

class ProcessLoopbackActivator final
    : public Microsoft::WRL::RuntimeClass<
          Microsoft::WRL::RuntimeClassFlags<Microsoft::WRL::ClassicCom>,
          IActivateAudioInterfaceCompletionHandler,
          Microsoft::WRL::FtmBase> {
public:
    ProcessLoopbackActivator() {
        m_doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    }

    ~ProcessLoopbackActivator() override {
        if (m_doneEvent) CloseHandle(m_doneEvent);
    }

    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        HRESULT hrActivate = E_FAIL;
        Microsoft::WRL::ComPtr<IUnknown> punk;
        HRESULT hr = operation->GetActivateResult(&hrActivate, &punk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && punk) {
            punk.As(&m_client);
            m_result = S_OK;
        } else {
            m_result = FAILED(hrActivate) ? hrActivate : hr;
        }
        SetEvent(m_doneEvent);
        return S_OK;
    }

    HRESULT WaitAndGet(IAudioClient** outClient, DWORD timeoutMs = 5000) {
        if (WaitForSingleObject(m_doneEvent, timeoutMs) != WAIT_OBJECT_0) {
            return HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        }
        if (FAILED(m_result) || !m_client) return m_result;
        *outClient = m_client.Detach();
        return S_OK;
    }

private:
    HANDLE m_doneEvent = nullptr;
    HRESULT m_result = E_FAIL;
    Microsoft::WRL::ComPtr<IAudioClient> m_client;
};

} // namespace detail

class AudioLoopbackService {
public:
    static constexpr uint32_t RingFrames = 16384; // Stereo frames (32768 float32s)
    static constexpr uint32_t HeaderBytes = 16;
    static constexpr uint64_t SharedBufferTotalBytes = HeaderBytes + (RingFrames * 2 * sizeof(float));

    explicit AudioLoopbackService(uint8_t* sharedPtr, std::function<void(const std::wstring&)> onStatus)
        : m_sharedPtr(sharedPtr), m_onStatus(std::move(onStatus)) {
        if (m_sharedPtr) {
            std::memset(m_sharedPtr, 0, static_cast<size_t>(SharedBufferTotalBytes));
        }
    }

    ~AudioLoopbackService() {
        Stop();
    }

    static DWORD FindDiscordRootPid() {
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE) return 0;

        struct ProcNode {
            DWORD pid;
            DWORD parentPid;
        };
        std::vector<ProcNode> discordNodes;
        std::unordered_set<DWORD> discordPidSet;

        PROCESSENTRY32W pe{};
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do {
                if (detail::IsDiscordExeName(pe.szExeFile)) {
                    discordNodes.push_back({pe.th32ProcessID, pe.th32ParentProcessID});
                    discordPidSet.insert(pe.th32ProcessID);
                }
            } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);

        if (discordNodes.empty()) return 0;

        DWORD bestPid = 0;
        uint64_t bestStart = UINT64_MAX;

        for (const auto& n : discordNodes) {
            if (discordPidSet.find(n.parentPid) == discordPidSet.end()) {
                uint64_t t = detail::GetProcessStartTicks(n.pid);
                if (bestPid == 0 || t < bestStart) {
                    bestPid = n.pid;
                    bestStart = t;
                }
            }
        }

        if (bestPid != 0) return bestPid;

        for (const auto& n : discordNodes) {
            uint64_t t = detail::GetProcessStartTicks(n.pid);
            if (bestPid == 0 || t < bestStart) {
                bestPid = n.pid;
                bestStart = t;
            }
        }
        return bestPid;
    }

    static std::wstring GetProcessBaseName(DWORD pid) {
        std::wstring result = L"Aplicativo";
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == INVALID_HANDLE_VALUE) return result;
        PROCESSENTRY32W pe{};
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do {
                if (pe.th32ProcessID == pid) {
                    result = detail::StripExeSuffix(pe.szExeFile);
                    break;
                }
            } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
        return result;
    }

    static void ListAudioApplications(std::vector<AudioAppItem>& outApps, bool& discordRunning, DWORD& discordPid) {
        discordPid = FindDiscordRootPid();
        discordRunning = (discordPid != 0);
        outApps.clear();

        std::unordered_map<DWORD, std::wstring> pidToName;
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe{};
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(snap, &pe)) {
                do {
                    if (!detail::IsDiscordExeName(pe.szExeFile)) {
                        pidToName[pe.th32ProcessID] = detail::StripExeSuffix(pe.szExeFile);
                    }
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }

        struct EnumCtx {
            DWORD selfPid;
            const std::unordered_map<DWORD, std::wstring>* names;
            std::unordered_set<DWORD> seenPids;
            std::vector<AudioAppItem>* out;
        } ctx{GetCurrentProcessId(), &pidToName, {}, &outApps};

        EnumWindows(
            [](HWND hwnd, LPARAM lParam) -> BOOL {
                auto* c = reinterpret_cast<EnumCtx*>(lParam);
                if (!IsWindowVisible(hwnd)) return TRUE;
                int len = GetWindowTextLengthW(hwnd);
                if (len <= 0) return TRUE;

                DWORD pid = 0;
                GetWindowThreadProcessId(hwnd, &pid);
                if (pid <= 4 || pid == c->selfPid || c->seenPids.count(pid)) return TRUE;

                auto it = c->names->find(pid);
                if (it == c->names->end()) return TRUE;

                std::wstring title(static_cast<size_t>(len) + 1, L'\0');
                int actual = GetWindowTextW(hwnd, title.data(), len + 1);
                if (actual <= 0) return TRUE;
                title.resize(static_cast<size_t>(actual));

                c->seenPids.insert(pid);
                c->out->push_back({pid, it->second, title});
                return TRUE;
            },
            reinterpret_cast<LPARAM>(&ctx));

        std::sort(outApps.begin(), outApps.end(), [](const AudioAppItem& a, const AudioAppItem& b) {
            return _wcsicmp(a.name.c_str(), b.name.c_str()) < 0;
        });
    }

    std::wstring Start(const std::wstring& mode, DWORD targetPid) {
        std::lock_guard<std::mutex> lock(m_mutex);
        StopUnlocked();

        if (mode == L"none") {
            return L"Sem som";
        }

        m_stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        std::wstring initialLabel;
        HANDLE readyEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);

        m_worker = std::thread([this, mode, targetPid, &initialLabel, readyEvent]() {
            CoInitializeEx(nullptr, COINIT_MULTITHREADED);
            DWORD mmcssIdx = 0;
            HANDLE hMmcss = AvSetMmThreadCharacteristicsW(L"Pro Audio", &mmcssIdx);

            CaptureLoop(mode, targetPid, initialLabel, readyEvent);

            if (hMmcss) AvRevertMmThreadCharacteristics(hMmcss);
            CoUninitialize();
        });

        WaitForSingleObject(readyEvent, 6000);
        CloseHandle(readyEvent);
        return initialLabel;
    }

    void Stop() {
        std::lock_guard<std::mutex> lock(m_mutex);
        StopUnlocked();
    }

private:
    void StopUnlocked() {
        if (m_stopEvent) {
            SetEvent(m_stopEvent);
        }
        if (m_worker.joinable()) {
            m_worker.join();
        }
        if (m_stopEvent) {
            CloseHandle(m_stopEvent);
            m_stopEvent = nullptr;
        }
    }

    static HRESULT OpenProcessLoopbackClient(DWORD pid, bool excludeTree, IAudioClient** outClient) {
        AUDIOCLIENT_ACTIVATION_PARAMS params{};
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        params.ProcessLoopbackParams.TargetProcessId = pid;
        params.ProcessLoopbackParams.ProcessLoopbackMode = excludeTree
            ? PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;

        PROPVARIANT prop{};
        prop.vt = VT_BLOB;
        prop.blob.cbSize = sizeof(params);
        prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

        auto handler = Microsoft::WRL::Make<detail::ProcessLoopbackActivator>();
        if (!handler) return E_OUTOFMEMORY;

        Microsoft::WRL::ComPtr<IActivateAudioInterfaceAsyncOperation> op;
        HRESULT hr = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            __uuidof(IAudioClient),
            &prop,
            handler.Get(),
            &op);
        if (FAILED(hr)) return hr;
        return handler->WaitAndGet(outClient, 5000);
    }

    static HRESULT OpenSystemLoopbackClient(IAudioClient** outClient) {
        Microsoft::WRL::ComPtr<IMMDeviceEnumerator> enumerator;
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator),
            nullptr,
            CLSCTX_ALL,
            IID_PPV_ARGS(&enumerator));
        if (FAILED(hr)) return hr;

        Microsoft::WRL::ComPtr<IMMDevice> device;
        hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
        if (FAILED(hr)) return hr;

        return device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(outClient));
    }

    bool SetupStream(
        const std::wstring& mode,
        DWORD targetPid,
        DWORD& activeExcludedPid,
        std::wstring& outLabel,
        Microsoft::WRL::ComPtr<IAudioClient>& outClient,
        Microsoft::WRL::ComPtr<IAudioCaptureClient>& outCapture,
        HANDLE sampleEvent) {

        outClient.Reset();
        outCapture.Reset();

        HRESULT hr = E_FAIL;
        if (mode == L"exclude-discord") {
            DWORD discordPid = FindDiscordRootPid();
            if (discordPid > 0) {
                activeExcludedPid = discordPid;
                hr = OpenProcessLoopbackClient(discordPid, true, &outClient);
                outLabel = L"Som do PC, sem o Discord";
            } else {
                activeExcludedPid = GetCurrentProcessId();
                hr = OpenProcessLoopbackClient(activeExcludedPid, true, &outClient);
                outLabel = L"Som do PC. Se o Discord abrir, fica de fora";
            }
        } else if (mode == L"include-process" && targetPid > 0) {
            hr = OpenProcessLoopbackClient(targetPid, false, &outClient);
            outLabel = L"Som só do " + GetProcessBaseName(targetPid);
        } else {
            hr = OpenSystemLoopbackClient(&outClient);
            outLabel = L"Som do PC inteiro";
        }

        if (FAILED(hr) || !outClient) {
            hr = OpenSystemLoopbackClient(&outClient);
            if (FAILED(hr) || !outClient) {
                outLabel = L"Som indisponível";
                return false;
            }
            if (mode != L"system-all") {
                outLabel = L"Som do PC inteiro (Windows antigo, sem filtro do Discord)";
            }
        }

        WAVEFORMATEX wfx{};
        wfx.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        wfx.nChannels = 2;
        wfx.nSamplesPerSec = 48000;
        wfx.wBitsPerSample = 32;
        wfx.nBlockAlign = (wfx.nChannels * wfx.wBitsPerSample) / 8;
        wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

        DWORD streamFlags = AUDCLNT_STREAMFLAGS_LOOPBACK |
                            AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;

        hr = outClient->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, 200000, 0, &wfx, nullptr);
        if (FAILED(hr)) return false;

        hr = outClient->SetEventHandle(sampleEvent);
        if (FAILED(hr)) return false;

        hr = outClient->GetService(IID_PPV_ARGS(&outCapture));
        if (FAILED(hr)) return false;

        hr = outClient->Start();
        return SUCCEEDED(hr);
    }

    void CaptureLoop(const std::wstring& mode, DWORD targetPid, std::wstring& initialLabel, HANDLE readyEvent) {
        HANDLE sampleEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        DWORD activeExcludedPid = 0;
        Microsoft::WRL::ComPtr<IAudioClient> client;
        Microsoft::WRL::ComPtr<IAudioCaptureClient> capture;

        bool ok = SetupStream(mode, targetPid, activeExcludedPid, initialLabel, client, capture, sampleEvent);
        SetEvent(readyEvent);
        if (!ok) {
            CloseHandle(sampleEvent);
            return;
        }

        ULONGLONG lastDiscordCheck = GetTickCount64();
        HANDLE waits[2] = {m_stopEvent, sampleEvent};

        while (true) {
            DWORD w = WaitForMultipleObjects(2, waits, FALSE, 40);
            if (w == WAIT_OBJECT_0) break;

            if (capture && m_sharedPtr) {
                UINT32 packetLen = 0;
                while (SUCCEEDED(capture->GetNextPacketSize(&packetLen)) && packetLen > 0) {
                    BYTE* data = nullptr;
                    UINT32 frames = 0;
                    DWORD flags = 0;
                    if (FAILED(capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr))) {
                        break;
                    }

                    auto* destRing = reinterpret_cast<float*>(m_sharedPtr + HeaderBytes);
                    uint32_t counter = m_writeCounter;
                    bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == nullptr;

                    if (silent) {
                        for (UINT32 i = 0; i < frames; ++i) {
                            uint32_t idx = (counter % RingFrames) * 2;
                            destRing[idx] = 0.0f;
                            destRing[idx + 1] = 0.0f;
                            ++counter;
                        }
                    } else {
                        const auto* src = reinterpret_cast<const float*>(data);
                        for (UINT32 i = 0; i < frames; ++i) {
                            uint32_t idx = (counter % RingFrames) * 2;
                            destRing[idx] = src[i * 2];
                            destRing[idx + 1] = src[i * 2 + 1];
                            ++counter;
                        }
                    }

                    m_writeCounter = counter;
                    InterlockedExchange(reinterpret_cast<volatile LONG*>(m_sharedPtr), static_cast<LONG>(counter));
                    capture->ReleaseBuffer(frames);
                }
            }

            if (mode == L"exclude-discord") {
                ULONGLONG now = GetTickCount64();
                if (now - lastDiscordCheck >= 4000) {
                    lastDiscordCheck = now;
                    DWORD currentDiscord = FindDiscordRootPid();
                    DWORD desiredPid = currentDiscord > 0 ? currentDiscord : GetCurrentProcessId();
                    if (desiredPid != activeExcludedPid) {
                        if (client) client->Stop();
                        std::wstring updatedLabel;
                        if (SetupStream(mode, 0, activeExcludedPid, updatedLabel, client, capture, sampleEvent) && m_onStatus) {
                            m_onStatus(updatedLabel);
                        }
                    }
                }
            }
        }

        if (client) client->Stop();
        CloseHandle(sampleEvent);
    }

    uint8_t* m_sharedPtr = nullptr;
    std::function<void(const std::wstring&)> m_onStatus;
    std::mutex m_mutex;
    std::thread m_worker;
    HANDLE m_stopEvent = nullptr;
    uint32_t m_writeCounter = 0;
};
