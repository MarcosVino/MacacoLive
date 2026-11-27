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
#include <winhttp.h>

#include <cstdint>
#include <fstream>
#include <string>
#include <vector>

namespace updater {

inline constexpr const wchar_t* kAppVersion = L"1.5.0";
inline constexpr const wchar_t* kDefaultUpdateApiUrl =
    L"https://api.github.com/repos/MarcosVino/MacacoLive/releases/latest";

struct UpdateInfo {
    bool available = false;
    std::wstring currentVersion = kAppVersion;
    std::wstring latestVersion;
    std::wstring downloadUrl;
    std::wstring notes;
};

inline std::wstring Utf8ToWide(const std::string& utf8) {
    if (utf8.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
    if (n <= 0) return L"";
    std::wstring out(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), out.data(), n);
    return out;
}

inline std::wstring GetExePath() {
    wchar_t buf[MAX_PATH * 4]{};
    DWORD len = GetModuleFileNameW(nullptr, buf, static_cast<DWORD>(std::size(buf)));
    return std::wstring(buf, len);
}

inline void CleanupOldBinary() {
    std::wstring oldPath = GetExePath() + L".old";
    DeleteFileW(oldPath.c_str());
    std::wstring newPath = GetExePath() + L".new";
    DeleteFileW(newPath.c_str());
}

inline std::vector<int> ParseVersionTuple(const std::wstring& v) {
    std::vector<int> parts;
    size_t i = 0;
    while (i < v.size() && (v[i] == L'v' || v[i] == L'V' || v[i] == L' ')) ++i;
    int cur = 0;
    bool hasDigit = false;
    for (; i < v.size(); ++i) {
        if (v[i] >= L'0' && v[i] <= L'9') {
            cur = cur * 10 + (v[i] - L'0');
            hasDigit = true;
        } else if (v[i] == L'.') {
            parts.push_back(cur);
            cur = 0;
            hasDigit = false;
        } else {
            break;
        }
    }
    if (hasDigit) parts.push_back(cur);
    while (parts.size() < 3) parts.push_back(0);
    return parts;
}

inline bool IsNewerVersion(const std::wstring& remote, const std::wstring& local) {
    auto r = ParseVersionTuple(remote);
    auto l = ParseVersionTuple(local);
    for (size_t i = 0; i < 3; ++i) {
        if (r[i] != l[i]) return r[i] > l[i];
    }
    return false;
}

inline bool HttpGetBytes(const std::wstring& url, std::vector<uint8_t>& outBody, DWORD maxBytes = 25 * 1024 * 1024) {
    outBody.clear();

    URL_COMPONENTSW uc{};
    uc.dwStructSize = sizeof(uc);
    wchar_t hostBuf[256]{};
    wchar_t pathBuf[2048]{};
    uc.lpszHostName = hostBuf;
    uc.dwHostNameLength = static_cast<DWORD>(std::size(hostBuf));
    uc.lpszUrlPath = pathBuf;
    uc.dwUrlPathLength = static_cast<DWORD>(std::size(pathBuf));

    if (!WinHttpCrackUrl(url.c_str(), static_cast<DWORD>(url.size()), 0, &uc)) {
        return false;
    }

    std::wstring host(uc.lpszHostName, uc.dwHostNameLength);
    std::wstring path(uc.lpszUrlPath, uc.dwUrlPathLength);
    if (path.empty()) path = L"/";

    HINTERNET hSession = WinHttpOpen(
        L"MacacoLive-Updater/1.3",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!hSession) return false;

    WinHttpSetTimeouts(hSession, 5000, 6000, 10000, 20000);

    HINTERNET hConnect = WinHttpConnect(hSession, host.c_str(), uc.nPort, 0);
    if (!hConnect) {
        WinHttpCloseHandle(hSession);
        return false;
    }

    DWORD reqFlags = (uc.nScheme == INTERNET_SCHEME_HTTPS) ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET hRequest = WinHttpOpenRequest(
        hConnect,
        L"GET",
        path.c_str(),
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        reqFlags);
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return false;
    }

    DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));

    const wchar_t* headers = L"Accept: application/vnd.github+json, application/json\r\n";
    bool ok = false;
    if (WinHttpSendRequest(hRequest, headers, static_cast<DWORD>(-1), WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(hRequest, nullptr)) {

        DWORD statusCode = 0;
        DWORD statusSize = sizeof(statusCode);
        WinHttpQueryHeaders(
            hRequest,
            WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
            WINHTTP_HEADER_NAME_BY_INDEX,
            &statusCode,
            &statusSize,
            WINHTTP_NO_HEADER_INDEX);

        if (statusCode == 200) {
            uint8_t chunk[16384];
            DWORD bytesAvail = 0;
            ok = true;
            while (WinHttpQueryDataAvailable(hRequest, &bytesAvail) && bytesAvail > 0) {
                DWORD toRead = (bytesAvail > sizeof(chunk)) ? sizeof(chunk) : bytesAvail;
                DWORD bytesRead = 0;
                if (!WinHttpReadData(hRequest, chunk, toRead, &bytesRead) || bytesRead == 0) {
                    ok = false;
                    break;
                }
                if (outBody.size() + bytesRead > maxBytes) {
                    ok = false;
                    break;
                }
                outBody.insert(outBody.end(), chunk, chunk + bytesRead);
            }
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return ok && !outBody.empty();
}

inline std::string ExtractJsonFieldUtf8(const std::string& json, const std::string& key, size_t startPos = 0) {
    std::string needle = "\"" + key + "\"";
    size_t pos = json.find(needle, startPos);
    if (pos == std::string::npos) return "";
    pos = json.find(':', pos + needle.size());
    if (pos == std::string::npos) return "";
    pos = json.find('\"', pos + 1);
    if (pos == std::string::npos) return "";
    ++pos;

    std::string val;
    while (pos < json.size()) {
        char c = json[pos++];
        if (c == '\\' && pos < json.size()) {
            char esc = json[pos++];
            switch (esc) {
                case '\"': val.push_back('\"'); break;
                case '\\': val.push_back('\\'); break;
                case '/':  val.push_back('/'); break;
                case 'n':  val.push_back(' '); break;
                case 'r':  break;
                default:   val.push_back(esc); break;
            }
        } else if (c == '\"') {
            break;
        } else {
            val.push_back(c);
        }
    }
    return val;
}

inline std::string FindExeDownloadUrl(const std::string& json) {
    // 1. Simple manifest format: {"version":"1.4.0","url":"https://.../MacacoLive.exe"}
    std::string directUrl = ExtractJsonFieldUtf8(json, "url");
    if (directUrl.find(".exe") != std::string::npos && directUrl.rfind("https://", 0) == 0) {
        return directUrl;
    }

    // 2. GitHub Releases API format: scan all browser_download_url entries for MacacoLive.exe
    size_t searchPos = 0;
    while (true) {
        size_t pos = json.find("\"browser_download_url\"", searchPos);
        if (pos == std::string::npos) break;
        std::string cand = ExtractJsonFieldUtf8(json, "browser_download_url", pos);
        if (cand.find("MacacoLive.exe") != std::string::npos && cand.rfind("https://", 0) == 0) {
            return cand;
        }
        searchPos = pos + 20;
    }
    return "";
}

inline std::wstring ResolveUpdateUrl() {
    // Allow optional override via update-url.txt beside MacacoLive.exe
    std::wstring exe = GetExePath();
    size_t slash = exe.find_last_of(L"\\/");
    if (slash != std::wstring::npos) {
        std::wstring cfgPath = exe.substr(0, slash + 1) + L"update-url.txt";
        std::ifstream f(cfgPath);
        if (f.is_open()) {
            std::string line;
            if (std::getline(f, line)) {
                while (!line.empty() && (line.back() == '\r' || line.back() == '\n' || line.back() == ' ')) {
                    line.pop_back();
                }
                if (line.rfind("https://", 0) == 0) {
                    return Utf8ToWide(line);
                }
            }
        }
    }
    return kDefaultUpdateApiUrl;
}

inline bool GetRedirectVersionFallback(std::wstring& outTag, std::wstring& outDownloadUrl) {
    outTag.clear();
    outDownloadUrl.clear();

    HINTERNET hSession = WinHttpOpen(
        L"MacacoLive-Updater/1.5",
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
        WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS,
        0);
    if (!hSession) return false;
    WinHttpSetTimeouts(hSession, 5000, 6000, 8000, 8000);

    HINTERNET hConnect = WinHttpConnect(hSession, L"github.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
    if (!hConnect) {
        WinHttpCloseHandle(hSession);
        return false;
    }

    HINTERNET hRequest = WinHttpOpenRequest(
        hConnect,
        L"HEAD",
        L"/MarcosVino/MacacoLive/releases/latest",
        nullptr,
        WINHTTP_NO_REFERER,
        WINHTTP_DEFAULT_ACCEPT_TYPES,
        WINHTTP_FLAG_SECURE);
    if (!hRequest) {
        WinHttpCloseHandle(hConnect);
        WinHttpCloseHandle(hSession);
        return false;
    }

    DWORD redirectPolicy = WINHTTP_OPTION_REDIRECT_POLICY_NEVER;
    WinHttpSetOption(hRequest, WINHTTP_OPTION_REDIRECT_POLICY, &redirectPolicy, sizeof(redirectPolicy));

    bool ok = false;
    if (WinHttpSendRequest(hRequest, WINHTTP_NO_ADDITIONAL_HEADERS, 0, WINHTTP_NO_REQUEST_DATA, 0, 0, 0) &&
        WinHttpReceiveResponse(hRequest, nullptr)) {

        wchar_t locBuf[1024]{};
        DWORD locSize = sizeof(locBuf);
        if (WinHttpQueryHeaders(
                hRequest,
                WINHTTP_QUERY_LOCATION,
                WINHTTP_HEADER_NAME_BY_INDEX,
                locBuf,
                &locSize,
                WINHTTP_NO_HEADER_INDEX)) {
            std::wstring loc(locBuf);
            size_t tagPos = loc.rfind(L"/tag/");
            if (tagPos != std::wstring::npos) {
                std::wstring tag = loc.substr(tagPos + 5);
                if (!tag.empty()) {
                    outTag = tag;
                    outDownloadUrl = L"https://github.com/MarcosVino/MacacoLive/releases/download/" + tag + L"/MacacoLive.exe";
                    ok = true;
                }
            }
        }
    }

    WinHttpCloseHandle(hRequest);
    WinHttpCloseHandle(hConnect);
    WinHttpCloseHandle(hSession);
    return ok;
}

inline UpdateInfo CheckForUpdates() {
    UpdateInfo info{};
    std::wstring apiUrl = ResolveUpdateUrl();
    if (apiUrl.empty()) return info;

    std::vector<uint8_t> raw;
    if (HttpGetBytes(apiUrl, raw, 512 * 1024)) {
        std::string json(reinterpret_cast<const char*>(raw.data()), raw.size());
        std::string verUtf8 = ExtractJsonFieldUtf8(json, "version");
        if (verUtf8.empty()) {
            verUtf8 = ExtractJsonFieldUtf8(json, "tag_name");
        }
        std::string dlUtf8 = FindExeDownloadUrl(json);
        std::string notesUtf8 = ExtractJsonFieldUtf8(json, "notes");
        if (notesUtf8.empty()) {
            notesUtf8 = ExtractJsonFieldUtf8(json, "name");
        }

        if (!verUtf8.empty() && !dlUtf8.empty()) {
            std::wstring remoteVer = Utf8ToWide(verUtf8);
            if (!remoteVer.empty() && (remoteVer[0] == L'v' || remoteVer[0] == L'V')) {
                remoteVer.erase(0, 1);
            }
            info.latestVersion = remoteVer;
            info.downloadUrl = Utf8ToWide(dlUtf8);
            info.notes = Utf8ToWide(notesUtf8);
            info.available = IsNewerVersion(info.latestVersion, info.currentVersion);
            return info;
        }
    }

    // Fallback when api.github.com hits unauthenticated IP rate limit (60/hr): read /releases/latest Location header
    std::wstring tag, dlUrl;
    if (GetRedirectVersionFallback(tag, dlUrl)) {
        std::wstring remoteVer = tag;
        if (!remoteVer.empty() && (remoteVer[0] == L'v' || remoteVer[0] == L'V')) {
            remoteVer.erase(0, 1);
        }
        info.latestVersion = remoteVer;
        info.downloadUrl = dlUrl;
        info.available = IsNewerVersion(info.latestVersion, info.currentVersion);
    }
    return info;
}

inline bool DownloadAndApplyUpdate(const std::wstring& downloadUrl, std::wstring& outError) {
    if (downloadUrl.rfind(L"https://", 0) != 0) {
        outError = L"URL de atualização inválida.";
        return false;
    }

    std::vector<uint8_t> bin;
    if (!HttpGetBytes(downloadUrl, bin, 25 * 1024 * 1024)) {
        outError = L"Falha ao baixar a nova versão. Tente novamente.";
        return false;
    }

    // Verify valid PE executable header ("MZ") and sane minimum size (> 100 KB)
    if (bin.size() < 100 * 1024 || bin[0] != 'M' || bin[1] != 'Z') {
        outError = L"Arquivo baixado não é um executável válido.";
        return false;
    }

    std::wstring exePath = GetExePath();
    std::wstring newPath = exePath + L".new";
    std::wstring oldPath = exePath + L".old";

    HANDLE hFile = CreateFileW(newPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (hFile == INVALID_HANDLE_VALUE) {
        outError = L"Sem permissão para gravar a atualização nesta pasta.";
        return false;
    }

    DWORD written = 0;
    BOOL writeOk = WriteFile(hFile, bin.data(), static_cast<DWORD>(bin.size()), &written, nullptr);
    CloseHandle(hFile);

    if (!writeOk || written != static_cast<DWORD>(bin.size())) {
        DeleteFileW(newPath.c_str());
        outError = L"Erro ao salvar o arquivo atualizado no disco.";
        return false;
    }

    // Atomic in-place self-swap (Windows allows renaming a running .exe!)
    DeleteFileW(oldPath.c_str());
    if (!MoveFileExW(exePath.c_str(), oldPath.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileW(newPath.c_str());
        outError = L"Não foi possível substituir o executável atual.";
        return false;
    }

    if (!MoveFileExW(newPath.c_str(), exePath.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        // Roll back
        MoveFileExW(oldPath.c_str(), exePath.c_str(), MOVEFILE_REPLACE_EXISTING);
        outError = L"Não foi possível mover a nova versão.";
        return false;
    }

    STARTUPINFOW si{};
    si.cb = sizeof(si);
    PROCESS_INFORMATION pi{};
    std::wstring cmdLine = L"\"" + exePath + L"\"";
    if (CreateProcessW(exePath.c_str(), cmdLine.data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return true;
    }

    outError = L"Atualizado com sucesso, mas falhou ao reabrir. Abra o MacacoLive novamente.";
    return false;
}

} // namespace updater
