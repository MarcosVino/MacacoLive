using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MacacoLive.App;

public sealed class MainForm : Form
{
    private readonly WebView2 _webView;
    private CoreWebView2SharedBuffer? _audioSharedBuffer;
    private AudioLoopbackService? _audioService;

    private bool _isBorderlessFullscreen;
    private FormWindowState _savedWindowState;
    private FormBorderStyle _savedBorderStyle;
    private Rectangle _savedBounds;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    public MainForm()
    {
        Text = "MacacoLive";
        Width = 1280;
        Height = 780;
        MinimumSize = new Size(900, 580);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(20, 17, 13);
        Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(20, 17, 13)
        };

        Controls.Add(_webView);

        Shown += async (_, _) =>
        {
            EnableDarkTitleBar();
            try
            {
                await InitializeWebViewAsync();
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    $"Não foi possível abrir o MacacoLive.\nO Microsoft Edge WebView2 Runtime precisa estar instalado (já vem no Windows 11).\n\nDetalhe: {ex.Message}",
                    "MacacoLive",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
        };

        FormClosing += (_, _) =>
        {
            _audioService?.Dispose();
            _audioSharedBuffer?.Dispose();
        };
    }

    private void EnableDarkTitleBar()
    {
        try
        {
            int useDark = 1;
            // DWMWA_USE_IMMERSIVE_DARK_MODE = 20
            _ = DwmSetWindowAttribute(Handle, 20, ref useDark, sizeof(int));
            // Windows 11: paint the caption with the app ground (#14110D) and cream text (#F4EDE1). COLORREF = 0x00BBGGRR
            int caption = 0x000D1114;
            _ = DwmSetWindowAttribute(Handle, 35, ref caption, sizeof(int));
            int captionText = 0x00E1EDF4;
            _ = DwmSetWindowAttribute(Handle, 36, ref captionText, sizeof(int));
        }
        catch
        {
        }
    }

    private async Task InitializeWebViewAsync()
    {
        // Anti-throttling & low-latency flags so MacacoLive runs smoothly for 6+ hours even minimized behind games/movies
        string chromiumArgs = string.Join(" ", new[]
        {
            "--disable-background-timer-throttling",
            "--disable-renderer-backgrounding",
            "--disable-backgrounding-occluded-windows",
            "--disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,WebRtcHideLocalIpsWithMdns",
            "--autoplay-policy=no-user-gesture-required",
            "--enable-gpu-rasterization",
            "--enable-zero-copy"
        });

        // Support running multiple simultaneous instances if needed via unique profile when shift/second instance opens
        string baseAppData = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MacacoLive");
        string userDataFolder = Path.Combine(baseAppData, "WebView2Profile");

        // Allow launching multiple windows simultaneously on the same PC without profile lock conflicts
        if (IsProfileLocked(userDataFolder))
        {
            userDataFolder = Path.Combine(baseAppData, $"WebView2Profile_{Environment.ProcessId}");
        }

        var options = new CoreWebView2EnvironmentOptions(chromiumArgs);
        var env = await CoreWebView2Environment.CreateAsync(null, userDataFolder, options);
        await _webView.EnsureCoreWebView2Async(env);

        var core = _webView.CoreWebView2;
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false;

        core.PermissionRequested += (_, args) =>
        {
            args.State = CoreWebView2PermissionState.Allow;
        };

        // Allocate zero-copy SharedBuffer for 48kHz Stereo PCM audio from WASAPI Process Loopback
        _audioSharedBuffer = env.CreateSharedBuffer(AudioLoopbackService.SharedBufferTotalBytes);
        _audioService = new AudioLoopbackService(_audioSharedBuffer.Buffer, statusMsg =>
        {
            if (IsDisposed) return;
            BeginInvoke(() =>
            {
                SendJsonEvent("audio-status", statusMsg);
            });
        });

        core.WebMessageReceived += async (_, args) =>
        {
            await HandleWebMessageAsync(args.TryGetWebMessageAsString());
        };

        core.NavigationCompleted += (_, _) =>
        {
            if (_audioSharedBuffer != null)
            {
                core.PostSharedBufferToScript(
                    _audioSharedBuffer,
                    CoreWebView2SharedBufferAccess.ReadOnly,
                    "{}");
            }
        };

        string wwwroot = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        if (Directory.Exists(wwwroot) && File.Exists(Path.Combine(wwwroot, "index.html")))
        {
            core.SetVirtualHostNameToFolderMapping(
                "app.macacolive",
                wwwroot,
                CoreWebView2HostResourceAccessKind.Allow);
            core.Navigate("https://app.macacolive/index.html");
        }
        else
        {
            // Dev server fallback
            core.Navigate("http://localhost:5173");
        }
    }

    private static bool IsProfileLocked(string profileDir)
    {
        try
        {
            string lockFile = Path.Combine(profileDir, "EBWebView", "SingletonLock");
            if (File.Exists(lockFile)) return true;

            var sameProcs = System.Diagnostics.Process.GetProcessesByName("MacacoLive");
            bool multiple = sameProcs.Length > 1;
            foreach (var p in sameProcs) p.Dispose();
            return multiple;
        }
        catch
        {
            return false;
        }
    }

    private async Task HandleWebMessageAsync(string? rawJson)
    {
        if (string.IsNullOrWhiteSpace(rawJson)) return;

        string? requestId = null;
        try
        {
            using var doc = JsonDocument.Parse(rawJson);
            var root = doc.RootElement;
            string cmd = root.TryGetProperty("cmd", out var cmdProp) ? cmdProp.GetString() ?? "" : "";
            requestId = root.TryGetProperty("requestId", out var reqProp) ? reqProp.GetString() : null;
            var payload = root.TryGetProperty("payload", out var payProp) ? payProp : default;

            switch (cmd)
            {
                case "listAudioApps":
                {
                    var (apps, discordRunning, discordPid) = await Task.Run(AudioLoopbackService.ListAudioApplications);
                    var processes = apps.Select(a => new
                    {
                        pid = a.Pid,
                        name = a.Name,
                        title = a.Title,
                        isDiscord = a.IsDiscord
                    }).ToList();

                    ReplySuccess(requestId, new
                    {
                        processes,
                        discordRunning,
                        discordPid
                    });
                    break;
                }

                case "startAudioCapture":
                {
                    if (_audioService == null)
                    {
                        ReplyError(requestId, "Serviço de áudio ainda não inicializado.");
                        break;
                    }

                    string mode = payload.ValueKind == JsonValueKind.Object &&
                                  payload.TryGetProperty("mode", out var mProp)
                        ? mProp.GetString() ?? "exclude-discord"
                        : "exclude-discord";

                    int targetPid = payload.ValueKind == JsonValueKind.Object &&
                                    payload.TryGetProperty("targetPid", out var pidProp) &&
                                    pidProp.TryGetInt32(out int parsedPid)
                        ? parsedPid
                        : 0;

                    var (activeMode, label) = await _audioService.StartCaptureAsync(mode, targetPid);
                    ReplySuccess(requestId, new { activeMode, label });
                    break;
                }

                case "stopAudioCapture":
                {
                    if (_audioService != null)
                    {
                        await _audioService.StopCaptureAsync();
                    }
                    ReplySuccess(requestId, new { ok = true });
                    break;
                }

                case "setFullscreen":
                {
                    bool fullscreen = payload.ValueKind == JsonValueKind.Object &&
                                      payload.TryGetProperty("fullscreen", out var fsProp) &&
                                      fsProp.GetBoolean();
                    SetBorderlessFullscreen(fullscreen);
                    ReplySuccess(requestId, new { fullscreen = _isBorderlessFullscreen });
                    break;
                }

                default:
                    ReplyError(requestId, $"Comando desconhecido: {cmd}");
                    break;
            }
        }
        catch (Exception ex)
        {
            ReplyError(requestId, ex.Message);
        }
    }

    private void SetBorderlessFullscreen(bool enable)
    {
        if (enable == _isBorderlessFullscreen) return;

        if (enable)
        {
            _savedWindowState = WindowState;
            _savedBorderStyle = FormBorderStyle;
            _savedBounds = Bounds;

            WindowState = FormWindowState.Normal;
            FormBorderStyle = FormBorderStyle.None;
            Bounds = Screen.FromControl(this).Bounds;
            _isBorderlessFullscreen = true;
        }
        else
        {
            FormBorderStyle = _savedBorderStyle == FormBorderStyle.None
                ? FormBorderStyle.Sizable
                : _savedBorderStyle;
            Bounds = _savedBounds.Width > 200 ? _savedBounds : new Rectangle(100, 100, 1280, 780);
            WindowState = _savedWindowState;
            _isBorderlessFullscreen = false;
        }
    }

    private void ReplySuccess(string? requestId, object data)
    {
        if (string.IsNullOrEmpty(requestId) || _webView.CoreWebView2 == null) return;
        string json = JsonSerializer.Serialize(new { requestId, data });
        _webView.CoreWebView2.PostWebMessageAsString(json);
    }

    private void ReplyError(string? requestId, string error)
    {
        if (string.IsNullOrEmpty(requestId) || _webView.CoreWebView2 == null) return;
        string json = JsonSerializer.Serialize(new { requestId, error });
        _webView.CoreWebView2.PostWebMessageAsString(json);
    }

    private void SendJsonEvent(string eventName, string message)
    {
        if (_webView.CoreWebView2 == null) return;
        string json = JsonSerializer.Serialize(new { @event = eventName, message });
        _webView.CoreWebView2.PostWebMessageAsString(json);
    }
}
