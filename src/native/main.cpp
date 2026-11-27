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
#include <dwmapi.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <wrl.h>

#include "WebView2.h"
#include "WebView2EnvironmentOptions.h"
#include "audio_loopback.h"
#include "dxgi_capture.h"
#include "embedded_assets.h"
#include "updater.h"

#include <cwctype>
#include <memory>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

using Microsoft::WRL::Callback;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::Make;

static constexpr UINT WM_APP_AUDIO_STATUS = WM_APP + 10;
static constexpr UINT WM_APP_POST_JSON    = WM_APP + 11;
static constexpr UINT WM_APP_CLOSE_NOW    = WM_APP + 12;

namespace perf_boost {

inline void DisableEcoQoSAndSetPriority(HANDLE hProcess, DWORD priorityClass) {
    if (!hProcess) return;
    PROCESS_POWER_THROTTLING_STATE pts{};
    pts.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    pts.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED;
    pts.StateMask = 0; // Explicitly disable Windows 11 Efficiency Mode (EcoQoS)
    SetProcessInformation(hProcess, ProcessPowerThrottling, &pts, sizeof(pts));
    SetPriorityClass(hProcess, priorityClass);
}

inline void BoostProcessTree(bool /*streamingActive*/) {
    DWORD selfPid = GetCurrentProcessId();
    // Keep NORMAL_PRIORITY_CLASS for WebView2 children so it never steals CPU from games like Valorant on weaker PCs,
    // while strictly disabling Windows 11 Efficiency Mode (EcoQoS) so Windows doesn't throttle encoding!
    DisableEcoQoSAndSetPriority(GetCurrentProcess(), NORMAL_PRIORITY_CLASS);

    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap == INVALID_HANDLE_VALUE) return;

    std::unordered_map<DWORD, std::vector<DWORD>> children;
    PROCESSENTRY32W pe{};
    pe.dwSize = sizeof(pe);
    if (Process32FirstW(snap, &pe)) {
        do {
            children[pe.th32ParentProcessID].push_back(pe.th32ProcessID);
        } while (Process32NextW(snap, &pe));
    }
    CloseHandle(snap);

    // BFS over all child/grandchild msedgewebview2.exe processes spawned by MacacoLive
    std::queue<DWORD> q;
    q.push(selfPid);
    while (!q.empty()) {
        DWORD cur = q.front();
        q.pop();
        auto it = children.find(cur);
        if (it == children.end()) continue;
        for (DWORD childPid : it->second) {
            q.push(childPid);
            HANDLE hChild = OpenProcess(PROCESS_SET_INFORMATION, FALSE, childPid);
            if (hChild) {
                DisableEcoQoSAndSetPriority(hChild, NORMAL_PRIORITY_CLASS);
                CloseHandle(hChild);
            }
        }
    }
}

} // namespace perf_boost

namespace json_mini {

inline std::wstring JsonEscape(const std::wstring& s) {
    std::wstring out;
    out.reserve(s.size() + 8);
    for (wchar_t ch : s) {
        switch (ch) {
            case L'\"': out += L"\\\""; break;
            case L'\\': out += L"\\\\"; break;
            case L'\n': out += L"\\n"; break;
            case L'\r': out += L"\\r"; break;
            case L'\t': out += L"\\t"; break;
            default:
                if (ch >= 0x20) out.push_back(ch);
                break;
        }
    }
    return out;
}

inline std::wstring ExtractString(const std::wstring& json, const std::wstring& key) {
    std::wstring needle = L"\"" + key + L"\"";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return L"";
    pos = json.find(L':', pos + needle.size());
    if (pos == std::wstring::npos) return L"";
    pos = json.find(L'\"', pos + 1);
    if (pos == std::wstring::npos) return L"";
    ++pos;

    std::wstring val;
    while (pos < json.size()) {
        wchar_t c = json[pos++];
        if (c == L'\\' && pos < json.size()) {
            wchar_t esc = json[pos++];
            switch (esc) {
                case L'\"': val.push_back(L'\"'); break;
                case L'\\': val.push_back(L'\\'); break;
                case L'/':  val.push_back(L'/'); break;
                case L'n':  val.push_back(L'\n'); break;
                case L'r':  val.push_back(L'\r'); break;
                case L't':  val.push_back(L'\t'); break;
                default:    val.push_back(esc); break;
            }
        } else if (c == L'\"') {
            break;
        } else {
            val.push_back(c);
        }
    }
    return val;
}

inline int ExtractInt(const std::wstring& json, const std::wstring& key, int fallback = 0) {
    std::wstring needle = L"\"" + key + L"\"";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return fallback;
    pos = json.find(L':', pos + needle.size());
    if (pos == std::wstring::npos) return fallback;
    ++pos;
    while (pos < json.size() && std::iswspace(json[pos])) ++pos;

    bool neg = false;
    if (pos < json.size() && json[pos] == L'-') {
        neg = true;
        ++pos;
    }
    if (pos >= json.size() || !std::iswdigit(json[pos])) return fallback;
    int val = 0;
    while (pos < json.size() && std::iswdigit(json[pos])) {
        val = val * 10 + (json[pos] - L'0');
        ++pos;
    }
    return neg ? -val : val;
}

inline bool ExtractBool(const std::wstring& json, const std::wstring& key, bool fallback = false) {
    std::wstring needle = L"\"" + key + L"\"";
    size_t pos = json.find(needle);
    if (pos == std::wstring::npos) return fallback;
    pos = json.find(L':', pos + needle.size());
    if (pos == std::wstring::npos) return fallback;
    ++pos;
    while (pos < json.size() && std::iswspace(json[pos])) ++pos;
    if (json.compare(pos, 4, L"true") == 0) return true;
    if (json.compare(pos, 5, L"false") == 0) return false;
    return fallback;
}

} // namespace json_mini

class MacacoAppWindow {
public:
    bool Create(HINSTANCE hInst, int nCmdShow) {
        m_hInst = hInst;
        HICON appIcon = LoadIconW(hInst, MAKEINTRESOURCEW(101));

        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.style = CS_HREDRAW | CS_VREDRAW;
        wc.lpfnWndProc = &MacacoAppWindow::WndProcSetup;
        wc.hInstance = hInst;
        wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
        wc.hIcon = appIcon;
        wc.hIconSm = appIcon;
        wc.hbrBackground = CreateSolidBrush(RGB(20, 17, 13));
        wc.lpszClassName = L"MacacoLiveNativeWindow";

        RegisterClassExW(&wc);

        int screenW = GetSystemMetrics(SM_CXSCREEN);
        int screenH = GetSystemMetrics(SM_CYSCREEN);
        int winW = 1280;
        int winH = 780;
        int posX = std::max(0, (screenW - winW) / 2);
        int posY = std::max(0, (screenH - winH) / 2);

        m_hwnd = CreateWindowExW(
            0,
            wc.lpszClassName,
            L"MacacoLive",
            WS_OVERLAPPEDWINDOW,
            posX,
            posY,
            winW,
            winH,
            nullptr,
            nullptr,
            hInst,
            this);

        if (!m_hwnd) return false;

        ApplyDarkWindowChrome();
        ShowWindow(m_hwnd, nCmdShow);
        UpdateWindow(m_hwnd);
        InitWebView();
        return true;
    }

private:
    void ApplyDarkWindowChrome() {
        BOOL useDark = TRUE;
        DwmSetWindowAttribute(m_hwnd, 20, &useDark, sizeof(useDark));
        COLORREF captionColor = RGB(20, 17, 13);
        DwmSetWindowAttribute(m_hwnd, 35, &captionColor, sizeof(captionColor));
        COLORREF textColor = RGB(244, 237, 225);
        DwmSetWindowAttribute(m_hwnd, 36, &textColor, sizeof(textColor));
    }

    static bool IsProfileInUse(const std::wstring& profileDir) {
        std::wstring lockFile = profileDir + L"\\EBWebView\\SingletonLock";
        if (GetFileAttributesW(lockFile.c_str()) != INVALID_FILE_ATTRIBUTES) {
            return true;
        }
        int count = 0;
        HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap != INVALID_HANDLE_VALUE) {
            PROCESSENTRY32W pe{};
            pe.dwSize = sizeof(pe);
            if (Process32FirstW(snap, &pe)) {
                do {
                    if (_wcsicmp(pe.szExeFile, L"MacacoLive.exe") == 0) ++count;
                } while (Process32NextW(snap, &pe));
            }
            CloseHandle(snap);
        }
        return count > 1;
    }

    std::wstring ResolveProfileFolder() {
        PWSTR localAppData = nullptr;
        std::wstring base = L".";
        if (SUCCEEDED(SHGetKnownFolderPath(FOLDERID_LocalAppData, 0, nullptr, &localAppData)) && localAppData) {
            base = localAppData;
            CoTaskMemFree(localAppData);
        }
        base += L"\\MacacoLive";
        CreateDirectoryW(base.c_str(), nullptr);

        std::wstring profile = base + L"\\WebView2Profile";
        if (IsProfileInUse(profile)) {
            profile = base + L"\\WebView2Profile_" + std::to_wstring(GetCurrentProcessId());
        }
        return profile;
    }

    void InitWebView() {
        auto options = Make<CoreWebView2EnvironmentOptions>();
        // Key flags for games & multi-hour streaming:
        // - Keep AllowWgcScreenCapturer ENABLED (Windows 10/11 WGC handles fullscreen/MPO games without freezing!),
        //   only disable AllowWgcZeroHz so capture never drops to 0fps.
        // - Enable MediaFoundationD3D11VideoCapture for GPU-accelerated video encoding/capture.
        // - Disable UseEcoQoSForBackgroundProcess so Windows 11 never throttles behind games.
        options->put_AdditionalBrowserArguments(
            L"--disable-background-timer-throttling "
            L"--disable-renderer-backgrounding "
            L"--disable-backgrounding-occluded-windows "
            L"--enable-features=MediaFoundationD3D11VideoCapture,MediaFoundationD3D11VideoCaptureZeroCopy "
            L"--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,WebRtcHideLocalIpsWithMdns,UseEcoQoSForBackgroundProcess,WGCScreenCapture "
            L"--autoplay-policy=no-user-gesture-required "
            L"--enable-gpu-rasterization "
            L"--enable-zero-copy "
            L"--ignore-gpu-blocklist "
            L"--force_high_performance_gpu");

        std::wstring userDataFolder = ResolveProfileFolder();

        HRESULT hr = CreateCoreWebView2EnvironmentWithOptions(
            nullptr,
            userDataFolder.c_str(),
            options.Get(),
            Callback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler>(
                [this](HRESULT result, ICoreWebView2Environment* env) -> HRESULT {
                    if (FAILED(result) || !env) {
                        MessageBoxW(
                            m_hwnd,
                            L"Não foi possível abrir o MacacoLive.\nVerifique se o Microsoft Edge WebView2 Runtime está instalado.",
                            L"MacacoLive",
                            MB_OK | MB_ICONERROR);
                        return result;
                    }
                    m_env = env;
                    return env->CreateCoreWebView2Controller(
                        m_hwnd,
                        Callback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler>(
                            [this](HRESULT ctrlHr, ICoreWebView2Controller* controller) -> HRESULT {
                                if (FAILED(ctrlHr) || !controller) return ctrlHr;
                                OnControllerReady(controller);
                                return S_OK;
                            })
                            .Get());
                })
                .Get());

        if (FAILED(hr)) {
            MessageBoxW(
                m_hwnd,
                L"O Microsoft Edge WebView2 Runtime não foi encontrado neste Windows.\nBaixe gratuitamente no site da Microsoft e tente abrir novamente.",
                L"MacacoLive",
                MB_OK | MB_ICONERROR);
        }
    }

    void PostJsonFromBackgroundThread(const std::wstring& json) {
        if (!m_hwnd) return;
        auto* copy = new std::wstring(json);
        if (!PostMessageW(m_hwnd, WM_APP_POST_JSON, 0, reinterpret_cast<LPARAM>(copy))) {
            delete copy;
        }
    }

    void OnControllerReady(ICoreWebView2Controller* controller) {
        m_controller = controller;

        ComPtr<ICoreWebView2Controller2> ctrl2;
        if (SUCCEEDED(m_controller.As(&ctrl2))) {
            COREWEBVIEW2_COLOR bg{255, 20, 17, 13};
            ctrl2->put_DefaultBackgroundColor(bg);
        }

        ResizeWebView();
        m_controller->get_CoreWebView2(&m_webview);
        if (!m_webview) return;

        // Immediately disable EcoQoS on spawned WebView2 GPU/renderer child processes
        perf_boost::BoostProcessTree(false);

        // Handle F11 and Escape at the WebView2 controller level so fullscreen never gets stuck
        m_controller->add_AcceleratorKeyPressed(
            Callback<ICoreWebView2AcceleratorKeyPressedEventHandler>(
                [this](ICoreWebView2Controller*, ICoreWebView2AcceleratorKeyPressedEventArgs* args) -> HRESULT {
                    COREWEBVIEW2_KEY_EVENT_KIND kind{};
                    UINT key = 0;
                    args->get_KeyEventKind(&kind);
                    args->get_VirtualKey(&key);
                    if (kind == COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN || kind == COREWEBVIEW2_KEY_EVENT_KIND_SYSTEM_KEY_DOWN) {
                        if (key == VK_F11) {
                            SetBorderlessFullscreen(!m_isFullscreen);
                            NotifyFullscreenState();
                            args->put_Handled(TRUE);
                        } else if (key == VK_ESCAPE && m_isFullscreen) {
                            SetBorderlessFullscreen(false);
                            NotifyFullscreenState();
                            args->put_Handled(TRUE);
                        }
                    }
                    return S_OK;
                })
                .Get(),
            nullptr);

        ComPtr<ICoreWebView2Settings> settings;
        if (SUCCEEDED(m_webview->get_Settings(&settings)) && settings) {
            settings->put_AreDefaultContextMenusEnabled(FALSE);
            settings->put_IsStatusBarEnabled(FALSE);
            settings->put_IsZoomControlEnabled(FALSE);
            ComPtr<ICoreWebView2Settings3> settings3;
            if (SUCCEEDED(settings.As(&settings3))) {
                settings3->put_AreBrowserAcceleratorKeysEnabled(FALSE);
            }
        }

        m_webview->add_PermissionRequested(
            Callback<ICoreWebView2PermissionRequestedEventHandler>(
                [](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                    args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    return S_OK;
                })
                .Get(),
            nullptr);

        // Allocate shared ring buffer for 48kHz stereo PCM audio and double-buffered GPU NV12 video
        ComPtr<ICoreWebView2Environment12> env12;
        if (SUCCEEDED(m_env.As(&env12))) {
            if (SUCCEEDED(env12->CreateSharedBuffer(AudioLoopbackService::SharedBufferTotalBytes, &m_sharedBuffer)) && m_sharedBuffer) {
                BYTE* rawBuf = nullptr;
                if (SUCCEEDED(m_sharedBuffer->get_Buffer(&rawBuf)) && rawBuf) {
                    HWND hwnd = m_hwnd;
                    m_audioService = std::make_unique<AudioLoopbackService>(rawBuf, [hwnd](const std::wstring& msg) {
                        auto* heapCopy = new std::wstring(msg);
                        if (!PostMessageW(hwnd, WM_APP_AUDIO_STATUS, 0, reinterpret_cast<LPARAM>(heapCopy))) {
                            delete heapCopy;
                        }
                    });
                }
            }

            if (SUCCEEDED(env12->CreateSharedBuffer(DxgiCaptureService::SharedBufferTotalBytes, &m_videoSharedBuffer)) && m_videoSharedBuffer) {
                BYTE* rawVid = nullptr;
                if (SUCCEEDED(m_videoSharedBuffer->get_Buffer(&rawVid)) && rawVid) {
                    m_dxgiService = std::make_unique<DxgiCaptureService>(rawVid);
                }
            }
        }

        // Serve embedded React/Vite assets directly from memory on https://app.macacolive/*
        m_webview->AddWebResourceRequestedFilter(
            L"https://app.macacolive/*",
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);

        m_webview->add_WebResourceRequested(
            Callback<ICoreWebView2WebResourceRequestedEventHandler>(
                [this](ICoreWebView2*, ICoreWebView2WebResourceRequestedEventArgs* args) -> HRESULT {
                    return HandleResourceRequest(args);
                })
                .Get(),
            nullptr);

        m_webview->add_NavigationCompleted(
            Callback<ICoreWebView2NavigationCompletedEventHandler>(
                [this](ICoreWebView2*, ICoreWebView2NavigationCompletedEventArgs*) -> HRESULT {
                    PostAllSharedBuffers();
                    return S_OK;
                })
                .Get(),
            nullptr);

        m_webview->add_WebMessageReceived(
            Callback<ICoreWebView2WebMessageReceivedEventHandler>(
                [this](ICoreWebView2*, ICoreWebView2WebMessageReceivedEventArgs* args) -> HRESULT {
                    LPWSTR raw = nullptr;
                    if (SUCCEEDED(args->TryGetWebMessageAsString(&raw)) && raw) {
                        std::wstring msg(raw);
                        CoTaskMemFree(raw);
                        HandleWebMessage(msg);
                    }
                    return S_OK;
                })
                .Get(),
            nullptr);

        m_webview->Navigate(L"https://app.macacolive/index.html");
    }

    HRESULT HandleResourceRequest(ICoreWebView2WebResourceRequestedEventArgs* args) {
        ComPtr<ICoreWebView2WebResourceRequest> req;
        if (FAILED(args->get_Request(&req)) || !req) return S_OK;

        LPWSTR uriRaw = nullptr;
        if (FAILED(req->get_Uri(&uriRaw)) || !uriRaw) return S_OK;
        std::wstring uri(uriRaw);
        CoTaskMemFree(uriRaw);

        const std::wstring origin = L"https://app.macacolive";
        if (uri.rfind(origin, 0) != 0) return S_OK;

        std::wstring path = uri.substr(origin.size());
        size_t qPos = path.find_first_of(L"?#");
        if (qPos != std::wstring::npos) path.resize(qPos);
        if (path.empty() || path == L"/") path = L"/index.html";

        const EmbeddedAsset* found = nullptr;
        for (size_t i = 0; i < kEmbeddedAssetCount; ++i) {
            if (_wcsicmp(path.c_str(), kEmbeddedAssets[i].path) == 0) {
                found = &kEmbeddedAssets[i];
                break;
            }
        }

        if (!found) {
            ComPtr<ICoreWebView2WebResourceResponse> notFound;
            if (SUCCEEDED(m_env->CreateWebResourceResponse(nullptr, 404, L"Not Found", L"", &notFound))) {
                args->put_Response(notFound.Get());
            }
            return S_OK;
        }

        ComPtr<IStream> stream;
        stream.Attach(SHCreateMemStream(found->data, found->size));
        std::wstring headers = std::wstring(L"Content-Type: ") + found->mime +
                               L"\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-store";

        ComPtr<ICoreWebView2WebResourceResponse> resp;
        if (SUCCEEDED(m_env->CreateWebResourceResponse(stream.Get(), 200, L"OK", headers.c_str(), &resp))) {
            args->put_Response(resp.Get());
        }
        return S_OK;
    }

    void PostAllSharedBuffers() {
        if (!m_webview) return;
        ComPtr<ICoreWebView2_17> wv17;
        if (FAILED(m_webview.As(&wv17)) || !wv17) return;
        if (m_sharedBuffer) {
            wv17->PostSharedBufferToScript(
                m_sharedBuffer.Get(),
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                L"{\"kind\":\"audio\"}");
        }
        if (m_videoSharedBuffer) {
            wv17->PostSharedBufferToScript(
                m_videoSharedBuffer.Get(),
                COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                L"{\"kind\":\"video\"}");
        }
    }

    void HandleWebMessage(const std::wstring& json) {
        std::wstring cmd = json_mini::ExtractString(json, L"cmd");
        std::wstring reqId = json_mini::ExtractString(json, L"requestId");

        if (cmd == L"requestSharedBuffer") {
            PostAllSharedBuffers();
            ReplySuccess(reqId, L"{\"ok\":true}");
            return;
        }

        if (cmd == L"listMonitors") {
            auto mons = DxgiCaptureService::ListMonitors();
            std::wstring data = L"{\"monitors\":[";
            for (size_t i = 0; i < mons.size(); ++i) {
                if (i > 0) data += L",";
                data += L"{\"index\":" + std::to_wstring(mons[i].index) +
                        L",\"name\":\"" + json_mini::JsonEscape(mons[i].name) +
                        L"\",\"width\":" + std::to_wstring(mons[i].width) +
                        L",\"height\":" + std::to_wstring(mons[i].height) +
                        L",\"primary\":" + (mons[i].primary ? L"true" : L"false") + L"}";
            }
            data += L"]}";
            ReplySuccess(reqId, data);
            return;
        }

        if (cmd == L"startDxgiCapture") {
            if (!m_dxgiService) {
                ReplyError(reqId, L"Captura DXGI não inicializada.");
                return;
            }
            int monitorIndex = json_mini::ExtractInt(json, L"monitorIndex", 0);
            int maxWidth = json_mini::ExtractInt(json, L"maxWidth", 1920);
            int maxHeight = json_mini::ExtractInt(json, L"maxHeight", 1080);
            int fps = json_mini::ExtractInt(json, L"fps", 60);
            if (m_dxgiService->Start(monitorIndex, maxWidth, maxHeight, fps)) {
                ReplySuccess(reqId, L"{\"ok\":true}");
            } else {
                ReplyError(reqId, L"Não foi possível iniciar captura DXGI neste monitor.");
            }
            return;
        }

        if (cmd == L"updateDxgiCapture") {
            if (m_dxgiService) {
                int maxWidth = json_mini::ExtractInt(json, L"maxWidth", 1920);
                int maxHeight = json_mini::ExtractInt(json, L"maxHeight", 1080);
                int fps = json_mini::ExtractInt(json, L"fps", 60);
                m_dxgiService->UpdateSettings(maxWidth, maxHeight, fps);
            }
            ReplySuccess(reqId, L"{\"ok\":true}");
            return;
        }

        if (cmd == L"stopDxgiCapture") {
            if (m_dxgiService) m_dxgiService->Stop();
            ReplySuccess(reqId, L"{\"ok\":true}");
            return;
        }

        if (cmd == L"setStreamingBoost") {
            bool active = json_mini::ExtractBool(json, L"active", false);
            perf_boost::BoostProcessTree(active);
            ReplySuccess(reqId, L"{\"ok\":true}");
            return;
        }

        if (cmd == L"checkUpdate") {
            std::thread([this, reqId]() {
                updater::UpdateInfo info = updater::CheckForUpdates();
                std::wstring data = std::wstring(L"{\"available\":") + (info.available ? L"true" : L"false") +
                                    L",\"currentVersion\":\"" + json_mini::JsonEscape(info.currentVersion) +
                                    L"\",\"latestVersion\":\"" + json_mini::JsonEscape(info.latestVersion) +
                                    L"\",\"downloadUrl\":\"" + json_mini::JsonEscape(info.downloadUrl) +
                                    L"\",\"notes\":\"" + json_mini::JsonEscape(info.notes) + L"\"}";
                std::wstring msg = L"{\"requestId\":\"" + json_mini::JsonEscape(reqId) +
                                   L"\",\"data\":" + data + L"}";
                PostJsonFromBackgroundThread(msg);
            }).detach();
            return;
        }

        if (cmd == L"installUpdate") {
            std::wstring url = json_mini::ExtractString(json, L"url");
            std::thread([this, reqId, url]() {
                std::wstring err;
                bool ok = updater::DownloadAndApplyUpdate(url, err);
                if (ok) {
                    std::wstring msg = L"{\"requestId\":\"" + json_mini::JsonEscape(reqId) +
                                       L"\",\"data\":{\"restarting\":true}}";
                    PostJsonFromBackgroundThread(msg);
                    Sleep(250);
                    if (m_hwnd) PostMessageW(m_hwnd, WM_APP_CLOSE_NOW, 0, 0);
                } else {
                    std::wstring msg = L"{\"requestId\":\"" + json_mini::JsonEscape(reqId) +
                                       L"\",\"error\":\"" + json_mini::JsonEscape(err) + L"\"}";
                    PostJsonFromBackgroundThread(msg);
                }
            }).detach();
            return;
        }

        if (cmd == L"listAudioApps") {
            std::vector<AudioAppItem> apps;
            bool discordRunning = false;
            DWORD discordPid = 0;
            AudioLoopbackService::ListAudioApplications(apps, discordRunning, discordPid);

            std::wstring data = L"{\"processes\":[";
            for (size_t i = 0; i < apps.size(); ++i) {
                if (i > 0) data += L",";
                data += L"{\"pid\":" + std::to_wstring(apps[i].pid) +
                        L",\"name\":\"" + json_mini::JsonEscape(apps[i].name) +
                        L"\",\"title\":\"" + json_mini::JsonEscape(apps[i].title) +
                        L"\",\"isDiscord\":false}";
            }
            data += L"],\"discordRunning\":";
            data += (discordRunning ? L"true" : L"false");
            data += L",\"discordPid\":" + std::to_wstring(discordPid) + L"}";
            ReplySuccess(reqId, data);
            return;
        }

        if (cmd == L"startAudioCapture") {
            if (!m_audioService) {
                ReplyError(reqId, L"Serviço de áudio indisponível.");
                return;
            }
            std::wstring mode = json_mini::ExtractString(json, L"mode");
            if (mode.empty()) mode = L"exclude-discord";
            int targetPid = json_mini::ExtractInt(json, L"targetPid", 0);

            std::wstring label = m_audioService->Start(mode, static_cast<DWORD>(std::max(0, targetPid)));
            std::wstring data = L"{\"activeMode\":\"" + json_mini::JsonEscape(mode) +
                                L"\",\"label\":\"" + json_mini::JsonEscape(label) + L"\"}";
            ReplySuccess(reqId, data);
            return;
        }

        if (cmd == L"stopAudioCapture") {
            if (m_audioService) m_audioService->Stop();
            ReplySuccess(reqId, L"{\"ok\":true}");
            return;
        }

        if (cmd == L"setFullscreen") {
            bool fs = json_mini::ExtractBool(json, L"fullscreen", false);
            SetBorderlessFullscreen(fs);
            ReplySuccess(reqId, std::wstring(L"{\"fullscreen\":") + (m_isFullscreen ? L"true" : L"false") + L"}");
            return;
        }

        ReplyError(reqId, L"Comando desconhecido");
    }

    void NotifyFullscreenState() {
        if (!m_webview) return;
        std::wstring ev = std::wstring(L"{\"event\":\"fullscreen-changed\",\"fullscreen\":") +
                          (m_isFullscreen ? L"true" : L"false") + L"}";
        m_webview->PostWebMessageAsString(ev.c_str());
    }

    void ReplySuccess(const std::wstring& reqId, const std::wstring& dataObjectJson) {
        if (reqId.empty() || !m_webview) return;
        std::wstring msg = L"{\"requestId\":\"" + json_mini::JsonEscape(reqId) +
                           L"\",\"data\":" + dataObjectJson + L"}";
        m_webview->PostWebMessageAsString(msg.c_str());
    }

    void ReplyError(const std::wstring& reqId, const std::wstring& errText) {
        if (reqId.empty() || !m_webview) return;
        std::wstring msg = L"{\"requestId\":\"" + json_mini::JsonEscape(reqId) +
                           L"\",\"error\":\"" + json_mini::JsonEscape(errText) + L"\"}";
        m_webview->PostWebMessageAsString(msg.c_str());
    }

    void SetBorderlessFullscreen(bool enable) {
        if (enable == m_isFullscreen) return;

        if (enable) {
            m_savedStyle = static_cast<DWORD>(GetWindowLongPtrW(m_hwnd, GWL_STYLE));
            m_savedExStyle = static_cast<DWORD>(GetWindowLongPtrW(m_hwnd, GWL_EXSTYLE));
            m_savedPlacement.length = sizeof(m_savedPlacement);
            GetWindowPlacement(m_hwnd, &m_savedPlacement);

            MONITORINFO mi{};
            mi.cbSize = sizeof(mi);
            if (GetMonitorInfoW(MonitorFromWindow(m_hwnd, MONITOR_DEFAULTTONEAREST), &mi)) {
                DWORD fsStyle = m_savedStyle & ~(WS_OVERLAPPEDWINDOW | WS_MAXIMIZE | WS_MINIMIZE);
                fsStyle |= WS_POPUP | WS_VISIBLE;
                SetWindowLongPtrW(m_hwnd, GWL_STYLE, fsStyle);
                SetWindowLongPtrW(m_hwnd, GWL_EXSTYLE, m_savedExStyle & ~(WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE));
                SetWindowPos(
                    m_hwnd,
                    HWND_TOP,
                    mi.rcMonitor.left,
                    mi.rcMonitor.top,
                    mi.rcMonitor.right - mi.rcMonitor.left,
                    mi.rcMonitor.bottom - mi.rcMonitor.top,
                    SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
                m_isFullscreen = true;
                ResizeWebView();
            }
        } else {
            DWORD restoreStyle = (m_savedStyle ? m_savedStyle : WS_OVERLAPPEDWINDOW) & ~WS_MAXIMIZE;
            restoreStyle |= WS_OVERLAPPEDWINDOW | WS_VISIBLE;
            SetWindowLongPtrW(m_hwnd, GWL_STYLE, restoreStyle);
            SetWindowLongPtrW(m_hwnd, GWL_EXSTYLE, m_savedExStyle);
            SetWindowPlacement(m_hwnd, &m_savedPlacement);
            SetWindowPos(
                m_hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            m_isFullscreen = false;
            ResizeWebView();
        }
    }

    void ResizeWebView() {
        if (!m_controller) return;
        RECT bounds{};
        GetClientRect(m_hwnd, &bounds);
        m_controller->put_Bounds(bounds);
    }

    static LRESULT CALLBACK WndProcSetup(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        if (msg == WM_NCCREATE) {
            auto* cs = reinterpret_cast<CREATESTRUCTW*>(lParam);
            auto* self = static_cast<MacacoAppWindow*>(cs->lpCreateParams);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(self));
            SetWindowLongPtrW(hwnd, GWLP_WNDPROC, reinterpret_cast<LONG_PTR>(&MacacoAppWindow::WndProcThunk));
            self->m_hwnd = hwnd;
            return self->HandleMessage(msg, wParam, lParam);
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    static LRESULT CALLBACK WndProcThunk(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        auto* self = reinterpret_cast<MacacoAppWindow*>(GetWindowLongPtrW(hwnd, GWLP_USERDATA));
        return self ? self->HandleMessage(msg, wParam, lParam) : DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    LRESULT HandleMessage(UINT msg, WPARAM wParam, LPARAM lParam) {
        switch (msg) {
            case WM_SIZE:
                ResizeWebView();
                return 0;

            case WM_GETMINMAXINFO: {
                auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
                mmi->ptMinTrackSize.x = 900;
                mmi->ptMinTrackSize.y = 580;
                return 0;
            }

            case WM_APP_AUDIO_STATUS: {
                auto* statusPtr = reinterpret_cast<std::wstring*>(lParam);
                if (statusPtr) {
                    if (m_webview) {
                        std::wstring ev = L"{\"event\":\"audio-status\",\"message\":\"" +
                                          json_mini::JsonEscape(*statusPtr) + L"\"}";
                        m_webview->PostWebMessageAsString(ev.c_str());
                    }
                    delete statusPtr;
                }
                return 0;
            }

            case WM_APP_POST_JSON: {
                auto* jsonPtr = reinterpret_cast<std::wstring*>(lParam);
                if (jsonPtr) {
                    if (m_webview) {
                        m_webview->PostWebMessageAsString(jsonPtr->c_str());
                    }
                    delete jsonPtr;
                }
                return 0;
            }

            case WM_APP_CLOSE_NOW:
                DestroyWindow(m_hwnd);
                return 0;

            case WM_DESTROY:
                if (m_dxgiService) {
                    m_dxgiService->Stop();
                    m_dxgiService.reset();
                }
                if (m_audioService) {
                    m_audioService->Stop();
                    m_audioService.reset();
                }
                m_videoSharedBuffer.Reset();
                m_sharedBuffer.Reset();
                m_webview.Reset();
                m_controller.Reset();
                m_env.Reset();
                PostQuitMessage(0);
                return 0;
        }
        return DefWindowProcW(m_hwnd, msg, wParam, lParam);
    }

    HINSTANCE m_hInst = nullptr;
    HWND m_hwnd = nullptr;
    bool m_isFullscreen = false;
    DWORD m_savedStyle = WS_OVERLAPPEDWINDOW;
    DWORD m_savedExStyle = 0;
    WINDOWPLACEMENT m_savedPlacement{sizeof(WINDOWPLACEMENT)};

    ComPtr<ICoreWebView2Environment> m_env;
    ComPtr<ICoreWebView2Controller> m_controller;
    ComPtr<ICoreWebView2> m_webview;
    ComPtr<ICoreWebView2SharedBuffer> m_sharedBuffer;
    ComPtr<ICoreWebView2SharedBuffer> m_videoSharedBuffer;
    std::unique_ptr<AudioLoopbackService> m_audioService;
    std::unique_ptr<DxgiCaptureService> m_dxgiService;
};

int WINAPI wWinMain(HINSTANCE hInstance, HINSTANCE, PWSTR, int nCmdShow) {
    updater::CleanupOldBinary();
    perf_boost::DisableEcoQoSAndSetPriority(GetCurrentProcess(), NORMAL_PRIORITY_CLASS);
    CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

    MacacoAppWindow app;
    if (!app.Create(hInstance, nCmdShow)) {
        CoUninitialize();
        return 1;
    }

    MSG msg{};
    while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    CoUninitialize();
    return static_cast<int>(msg.wParam);
}
