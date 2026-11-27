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
#include <objidl.h>
#include <gdiplus.h>
#include <tlhelp32.h>
#include <shellapi.h>

#include <algorithm>
#include <cstdint>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace preview_helper {

struct GdiPlusScope {
    ULONG_PTR token = 0;
    GdiPlusScope() {
        Gdiplus::GdiplusStartupInput input;
        Gdiplus::GdiplusStartup(&token, &input, nullptr);
    }
    ~GdiPlusScope() {
        if (token) Gdiplus::GdiplusShutdown(token);
    }
};

inline std::wstring Base64Encode(const uint8_t* data, size_t len) {
    static constexpr wchar_t tbl[] =
        L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::wstring out;
    out.reserve(((len + 2) / 3) * 4);
    for (size_t i = 0; i < len; i += 3) {
        uint32_t b = static_cast<uint32_t>(data[i]) << 16;
        if (i + 1 < len) b |= static_cast<uint32_t>(data[i + 1]) << 8;
        if (i + 2 < len) b |= static_cast<uint32_t>(data[i + 2]);
        out.push_back(tbl[(b >> 18) & 0x3F]);
        out.push_back(tbl[(b >> 12) & 0x3F]);
        out.push_back((i + 1 < len) ? tbl[(b >> 6) & 0x3F] : L'=');
        out.push_back((i + 2 < len) ? tbl[b & 0x3F] : L'=');
    }
    return out;
}

inline bool GetEncoderClsid(const wchar_t* mime, CLSID& outClsid) {
    UINT num = 0, size = 0;
    Gdiplus::GetImageEncodersSize(&num, &size);
    if (size == 0) return false;
    std::vector<uint8_t> buf(size);
    auto* encoders = reinterpret_cast<Gdiplus::ImageCodecInfo*>(buf.data());
    if (Gdiplus::GetImageEncoders(num, size, encoders) != Gdiplus::Ok) return false;
    for (UINT i = 0; i < num; ++i) {
        if (encoders[i].MimeType && _wcsicmp(encoders[i].MimeType, mime) == 0) {
            outClsid = encoders[i].Clsid;
            return true;
        }
    }
    return false;
}

inline std::wstring BitmapToDataUrl(Gdiplus::Bitmap& bmp, const wchar_t* mime, const wchar_t* prefix) {
    CLSID clsid{};
    if (!GetEncoderClsid(mime, clsid)) return L"";

    IStream* rawStream = nullptr;
    if (FAILED(CreateStreamOnHGlobal(nullptr, TRUE, &rawStream)) || !rawStream) return L"";

    std::wstring result;
    if (bmp.Save(rawStream, &clsid, nullptr) == Gdiplus::Ok) {
        HGLOBAL hMem = nullptr;
        if (SUCCEEDED(GetHGlobalFromStream(rawStream, &hMem)) && hMem) {
            SIZE_T sz = GlobalSize(hMem);
            void* ptr = GlobalLock(hMem);
            if (ptr && sz > 0) {
                result = prefix + Base64Encode(static_cast<const uint8_t*>(ptr), sz);
            }
            if (ptr) GlobalUnlock(hMem);
        }
    }
    rawStream->Release();
    return result;
}

inline std::wstring CaptureRectThumbnailDataUrl(const RECT& rc, int thumbW, int thumbH) {
    int srcW = rc.right - rc.left;
    int srcH = rc.bottom - rc.top;
    if (srcW <= 0 || srcH <= 0) return L"";

    HDC hScreen = GetDC(nullptr);
    HDC hMem = CreateCompatibleDC(hScreen);
    HBITMAP hBmp = CreateCompatibleBitmap(hScreen, thumbW, thumbH);
    HGDIOBJ oldObj = SelectObject(hMem, hBmp);

    SetStretchBltMode(hMem, HALFTONE);
    SetBrushOrgEx(hMem, 0, 0, nullptr);
    StretchBlt(hMem, 0, 0, thumbW, thumbH, hScreen, rc.left, rc.top, srcW, srcH, SRCCOPY);

    std::wstring dataUrl;
    {
        Gdiplus::Bitmap gdipBmp(hBmp, nullptr);
        dataUrl = BitmapToDataUrl(gdipBmp, L"image/jpeg", L"data:image/jpeg;base64,");
    }

    SelectObject(hMem, oldObj);
    DeleteObject(hBmp);
    DeleteDC(hMem);
    ReleaseDC(nullptr, hScreen);
    return dataUrl;
}

struct MonitorPreviewItem {
    int index;
    std::wstring name;
    int width;
    int height;
    bool primary;
    std::wstring thumbDataUrl;
};

struct WindowPreviewItem {
    DWORD pid;
    std::wstring name;
    std::wstring title;
    std::wstring iconDataUrl;
};

inline void AttachDesktopForPreview() {
    HDESK hDesk = OpenInputDesktop(0, FALSE, DESKTOP_CREATEWINDOW | DESKTOP_READOBJECTS | GENERIC_READ);
    if (hDesk) {
        SetThreadDesktop(hDesk);
        CloseDesktop(hDesk);
    }
}

inline std::vector<MonitorPreviewItem> CaptureMonitorPreviews() {
    AttachDesktopForPreview();
    GdiPlusScope gdi;
    struct EnumState {
        std::vector<MonitorPreviewItem> items;
    } st;

    EnumDisplayMonitors(
        nullptr,
        nullptr,
        [](HMONITOR hMon, HDC, LPRECT, LPARAM lParam) -> BOOL {
            auto* s = reinterpret_cast<EnumState*>(lParam);
            MONITORINFOEXW mi{};
            mi.cbSize = sizeof(mi);
            if (!GetMonitorInfoW(hMon, &mi)) return TRUE;

            int idx = static_cast<int>(s->items.size());
            int w = mi.rcMonitor.right - mi.rcMonitor.left;
            int h = mi.rcMonitor.bottom - mi.rcMonitor.top;
            bool primary = (mi.dwFlags & MONITORINFOF_PRIMARY) != 0;

            int thumbW = 320;
            int thumbH = std::max(120, (thumbW * h) / std::max(1, w));
            std::wstring thumb = CaptureRectThumbnailDataUrl(mi.rcMonitor, thumbW, thumbH);

            std::wstring label = L"Monitor " + std::to_wstring(idx + 1) +
                                 L" (" + std::to_wstring(w) + L"x" + std::to_wstring(h) + L")";
            if (primary) label += L" — Principal";

            s->items.push_back({idx, label, w, h, primary, std::move(thumb)});
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&st));

    return st.items;
}

inline HICON ResolveWindowIcon(HWND hwnd, DWORD pid) {
    HICON hIcon = nullptr;
    DWORD_PTR res = 0;
    if (SendMessageTimeoutW(hwnd, WM_GETICON, ICON_BIG, 0, SMTO_ABORTIFHUNG, 50, &res) && res) {
        return reinterpret_cast<HICON>(res);
    }
    if (SendMessageTimeoutW(hwnd, WM_GETICON, ICON_SMALL2, 0, SMTO_ABORTIFHUNG, 50, &res) && res) {
        return reinterpret_cast<HICON>(res);
    }
    ULONG_PTR clsIcon = GetClassLongPtrW(hwnd, GCLP_HICON);
    if (clsIcon) return reinterpret_cast<HICON>(clsIcon);
    clsIcon = GetClassLongPtrW(hwnd, GCLP_HICONSM);
    if (clsIcon) return reinterpret_cast<HICON>(clsIcon);

    HANDLE hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (hProc) {
        wchar_t exePath[MAX_PATH * 2]{};
        DWORD sz = static_cast<DWORD>(std::size(exePath));
        if (QueryFullProcessImageNameW(hProc, 0, exePath, &sz)) {
            SHFILEINFOW sfi{};
            if (SHGetFileInfoW(exePath, 0, &sfi, sizeof(sfi), SHGFI_ICON | SHGFI_LARGEICON)) {
                hIcon = sfi.hIcon;
            }
        }
        CloseHandle(hProc);
    }
    return hIcon;
}

inline std::wstring IconToPngDataUrl(HICON hIcon) {
    if (!hIcon) return L"";
    ICONINFO ii{};
    if (!GetIconInfo(hIcon, &ii)) return L"";

    // Draw icon onto 32-bit ARGB DIB so alpha transparency is preserved cleanly
    BITMAPV5HEADER bi{};
    bi.bV5Size = sizeof(bi);
    bi.bV5Width = 32;
    bi.bV5Height = -32;
    bi.bV5Planes = 1;
    bi.bV5BitCount = 32;
    bi.bV5Compression = BI_BITFIELDS;
    bi.bV5RedMask = 0x00FF0000;
    bi.bV5GreenMask = 0x0000FF00;
    bi.bV5BlueMask = 0x000000FF;
    bi.bV5AlphaMask = 0xFF000000;

    void* bits = nullptr;
    HDC hdc = GetDC(nullptr);
    HBITMAP hDib = CreateDIBSection(hdc, reinterpret_cast<BITMAPINFO*>(&bi), DIB_RGB_COLORS, &bits, nullptr, 0);
    std::wstring dataUrl;
    if (hDib && bits) {
        std::memset(bits, 0, 32 * 32 * 4);
        HDC hMem = CreateCompatibleDC(hdc);
        HGDIOBJ old = SelectObject(hMem, hDib);
        DrawIconEx(hMem, 0, 0, hIcon, 32, 32, 0, nullptr, DI_NORMAL);
        SelectObject(hMem, old);
        DeleteDC(hMem);

        Gdiplus::Bitmap bmp(32, 32, 32 * 4, PixelFormat32bppARGB, static_cast<BYTE*>(bits));
        dataUrl = BitmapToDataUrl(bmp, L"image/png", L"data:image/png;base64,");
    }
    if (hDib) DeleteObject(hDib);
    ReleaseDC(nullptr, hdc);
    if (ii.hbmColor) DeleteObject(ii.hbmColor);
    if (ii.hbmMask) DeleteObject(ii.hbmMask);
    return dataUrl;
}

inline std::vector<WindowPreviewItem> CaptureWindowPreviews() {
    AttachDesktopForPreview();
    GdiPlusScope gdi;
    std::vector<WindowPreviewItem> out;

    std::unordered_map<DWORD, std::wstring> pidNames;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
        PROCESSENTRY32W pe{};
        pe.dwSize = sizeof(pe);
        if (Process32FirstW(snap, &pe)) {
            do {
                std::wstring exe = pe.szExeFile;
                if (exe.size() > 4 && _wcsicmp(exe.c_str() + exe.size() - 4, L".exe") == 0) {
                    exe.resize(exe.size() - 4);
                }
                if (_wcsicmp(exe.c_str(), L"Discord") != 0 &&
                    _wcsicmp(exe.c_str(), L"DiscordPTB") != 0 &&
                    _wcsicmp(exe.c_str(), L"DiscordCanary") != 0 &&
                    _wcsicmp(exe.c_str(), L"TextInputHost") != 0 &&
                    _wcsicmp(exe.c_str(), L"ApplicationFrameHost") != 0 &&
                    _wcsicmp(exe.c_str(), L"ShellExperienceHost") != 0 &&
                    _wcsicmp(exe.c_str(), L"SearchHost") != 0) {
                    pidNames[pe.th32ProcessID] = exe;
                }
            } while (Process32NextW(snap, &pe));
        }
        CloseHandle(snap);
    }

    struct Ctx {
        DWORD selfPid;
        const std::unordered_map<DWORD, std::wstring>* names;
        std::unordered_set<DWORD> seenPids;
        std::vector<WindowPreviewItem>* out;
    } ctx{GetCurrentProcessId(), &pidNames, {}, &out};

    EnumWindows(
        [](HWND hwnd, LPARAM lParam) -> BOOL {
            auto* c = reinterpret_cast<Ctx*>(lParam);
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return TRUE;
            LONG exStyle = GetWindowLongW(hwnd, GWL_EXSTYLE);
            if (exStyle & WS_EX_TOOLWINDOW) return TRUE;

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

            HICON hIcon = ResolveWindowIcon(hwnd, pid);
            std::wstring iconUrl = IconToPngDataUrl(hIcon);

            c->seenPids.insert(pid);
            c->out->push_back({pid, it->second, title, std::move(iconUrl)});
            return TRUE;
        },
        reinterpret_cast<LPARAM>(&ctx));

    std::sort(out.begin(), out.end(), [](const WindowPreviewItem& a, const WindowPreviewItem& b) {
        return _wcsicmp(a.name.c_str(), b.name.c_str()) < 0;
    });
    return out;
}

} // namespace preview_helper
