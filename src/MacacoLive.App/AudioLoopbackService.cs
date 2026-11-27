using System.Diagnostics;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace MacacoLive.App;

public sealed record AudioAppEntry(int Pid, string Name, string Title, bool IsDiscord);

public sealed class AudioLoopbackService : IDisposable
{
    public const int RingFrames = 16384; // Stereo frames (32768 floats)
    public const int HeaderBytes = 16;
    public const ulong SharedBufferTotalBytes = HeaderBytes + (RingFrames * 2 * sizeof(float));

    private readonly IntPtr _sharedBufferPtr;
    private readonly Action<string>? _onStatusChanged;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private WasapiRecorder? _recorder;
    private uint _writeCounter;
    private string _currentMode = "none";
    private int _currentTargetPid;
    private uint _activeExcludedDiscordPid;
    private System.Threading.Timer? _discordWatchTimer;
    private bool _disposed;

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        out PROCESS_BASIC_INFORMATION processInformation,
        int processInformationLength,
        out int returnLength);

    public unsafe AudioLoopbackService(IntPtr sharedBufferPtr, Action<string>? onStatusChanged = null)
    {
        _sharedBufferPtr = sharedBufferPtr;
        _onStatusChanged = onStatusChanged;

        if (_sharedBufferPtr != IntPtr.Zero)
        {
            NativeMemory.Clear((void*)_sharedBufferPtr, (nuint)SharedBufferTotalBytes);
        }
    }

    public static (List<AudioAppEntry> Apps, bool DiscordRunning, int DiscordRootPid) ListAudioApplications()
    {
        int discordRoot = FindDiscordRootPid();
        var result = new List<AudioAppEntry>();
        int selfPid = Environment.ProcessId;

        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                if (proc.Id <= 4 || proc.Id == selfPid) continue;
                if (proc.MainWindowHandle == IntPtr.Zero) continue;

                string title = proc.MainWindowTitle?.Trim() ?? "";
                if (string.IsNullOrWhiteSpace(title)) continue;

                string name = proc.ProcessName;
                bool isDiscord = name.Contains("Discord", StringComparison.OrdinalIgnoreCase);
                if (isDiscord) continue; // Listed separately by the automatic Discord shield

                result.Add(new AudioAppEntry(proc.Id, name, title, false));
            }
            catch
            {
                // Ignore protected system processes
            }
            finally
            {
                proc.Dispose();
            }
        }

        result.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));
        return (result, discordRoot > 0, discordRoot);
    }

    public static int FindDiscordRootPid()
    {
        var discordProcs = Process.GetProcessesByName("Discord")
            .Concat(Process.GetProcessesByName("DiscordPTB"))
            .Concat(Process.GetProcessesByName("DiscordCanary"))
            .ToList();

        if (discordProcs.Count == 0) return 0;

        try
        {
            var pidSet = discordProcs.Select(p => p.Id).ToHashSet();
            var roots = new List<(int Pid, DateTime StartTime)>();

            foreach (var p in discordProcs)
            {
                int parentPid = GetParentProcessId(p);
                DateTime start = SafeGetStartTime(p);
                if (!pidSet.Contains(parentPid))
                {
                    roots.Add((p.Id, start));
                }
            }

            if (roots.Count > 0)
            {
                return roots.OrderBy(r => r.StartTime).First().Pid;
            }

            return discordProcs.OrderBy(SafeGetStartTime).First().Id;
        }
        finally
        {
            foreach (var p in discordProcs) p.Dispose();
        }
    }

    private static int GetParentProcessId(Process process)
    {
        try
        {
            int status = NtQueryInformationProcess(
                process.Handle,
                0,
                out var pbi,
                Marshal.SizeOf<PROCESS_BASIC_INFORMATION>(),
                out _);
            if (status == 0)
            {
                return pbi.InheritedFromUniqueProcessId.ToInt32();
            }
        }
        catch
        {
        }
        return 0;
    }

    private static DateTime SafeGetStartTime(Process p)
    {
        try
        {
            return p.StartTime;
        }
        catch
        {
            return DateTime.MaxValue;
        }
    }

    public async Task<(string ActiveMode, string Label)> StartCaptureAsync(string mode, int targetPid)
    {
        await _gate.WaitAsync();
        try
        {
            await StopInternalAsync();
            _currentMode = mode;
            _currentTargetPid = targetPid;

            if (mode == "none")
            {
                return ("none", "Sem som");
            }

            string label = await StartRecorderCoreAsync(mode, targetPid);

            if (mode == "exclude-discord")
            {
                _discordWatchTimer = new System.Threading.Timer(
                    _ => _ = CheckDiscordProcessChangesAsync(),
                    null,
                    TimeSpan.FromSeconds(4),
                    TimeSpan.FromSeconds(4));
            }

            return (mode, label);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task CheckDiscordProcessChangesAsync()
    {
        if (_disposed || _currentMode != "exclude-discord") return;
        int currentDiscordPid = FindDiscordRootPid();
        uint desiredPid = currentDiscordPid > 0 ? (uint)currentDiscordPid : (uint)Environment.ProcessId;

        if (desiredPid == _activeExcludedDiscordPid) return;

        await _gate.WaitAsync();
        try
        {
            if (_disposed || _currentMode != "exclude-discord") return;
            if (desiredPid == _activeExcludedDiscordPid) return;

            StopRecorderOnly();
            string updatedLabel = await StartRecorderCoreAsync("exclude-discord", 0);
            _onStatusChanged?.Invoke(updatedLabel);
        }
        catch
        {
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<string> StartRecorderCoreAsync(string mode, int targetPid)
    {
        var targetFormat = WaveFormat.CreateIeeeFloatWaveFormat(48000, 2);
        var builder = new WasapiRecorderBuilder()
            .WithSharedMode()
            .WithEventSync()
            .WithFormat(targetFormat)
            .WithBufferLength(20)
            .WithMmcssThreadPriority("Pro Audio");

        string label;

        if (mode == "exclude-discord" && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
        {
            int discordPid = FindDiscordRootPid();
            if (discordPid > 0)
            {
                _activeExcludedDiscordPid = (uint)discordPid;
                builder.WithProcessLoopback(_activeExcludedDiscordPid, ProcessLoopbackMode.ExcludeTargetProcessTree);
                label = "Som do PC, sem o Discord";
            }
            else
            {
                // Exclude MacacoLive itself while monitoring if Discord opens later
                _activeExcludedDiscordPid = (uint)Environment.ProcessId;
                builder.WithProcessLoopback(_activeExcludedDiscordPid, ProcessLoopbackMode.ExcludeTargetProcessTree);
                label = "Som do PC. Se o Discord abrir, fica de fora";
            }
        }
        else if (mode == "include-process" && targetPid > 0 && OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041))
        {
            builder.WithProcessLoopback((uint)targetPid, ProcessLoopbackMode.IncludeTargetProcessTree);
            string procName = "Aplicativo";
            try
            {
                using var p = Process.GetProcessById(targetPid);
                procName = p.ProcessName;
            }
            catch
            {
            }
            label = $"Som só do {procName}";
        }
        else
        {
            builder.WithLoopbackCapture();
            label = "Som do PC inteiro";
        }

        try
        {
            _recorder = await builder.BuildAsync();
        }
        catch
        {
            // Graceful fallback on older Windows builds without Process Loopback support
            var fallback = new WasapiRecorderBuilder()
                .WithSharedMode()
                .WithEventSync()
                .WithLoopbackCapture()
                .WithFormat(targetFormat)
                .WithBufferLength(25)
                .WithMmcssThreadPriority("Pro Audio");
            _recorder = await fallback.BuildAsync();
            label = "Som do PC inteiro (Windows antigo, sem filtro do Discord)";
        }

        _recorder.DataAvailable += OnWasapiDataAvailable;
        _recorder.StartRecording();
        return label;
    }

    private unsafe void OnWasapiDataAvailable(
        ReadOnlySpan<byte> buffer,
        AudioClientBufferFlags flags,
        long devicePosition,
        long qpcPosition)
    {
        if (_sharedBufferPtr == IntPtr.Zero || buffer.IsEmpty || _recorder == null) return;

        int channels = _recorder.WaveFormat.Channels;
        if (channels <= 0) return;

        int bytesPerSample = _recorder.WaveFormat.BitsPerSample / 8;
        if (bytesPerSample != 4) return;

        int frameStrideBytes = channels * 4;
        int frameCount = buffer.Length / frameStrideBytes;
        if (frameCount <= 0) return;

        float* destRing = (float*)((byte*)_sharedBufferPtr + HeaderBytes);
        uint counter = _writeCounter;
        bool isSilent = (flags & AudioClientBufferFlags.Silent) != 0;

        if (isSilent)
        {
            for (int i = 0; i < frameCount; i++)
            {
                uint idx = (counter % RingFrames) * 2;
                destRing[idx] = 0f;
                destRing[idx + 1] = 0f;
                counter++;
            }
        }
        else
        {
            ReadOnlySpan<float> srcFloats = MemoryMarshal.Cast<byte, float>(buffer);
            for (int i = 0; i < frameCount; i++)
            {
                int srcBase = i * channels;
                float left = srcFloats[srcBase];
                float right = channels >= 2 ? srcFloats[srcBase + 1] : left;

                uint idx = (counter % RingFrames) * 2;
                destRing[idx] = left;
                destRing[idx + 1] = right;
                counter++;
            }
        }

        _writeCounter = counter;
        Volatile.Write(ref *(uint*)_sharedBufferPtr, counter);
    }

    public async Task StopCaptureAsync()
    {
        await _gate.WaitAsync();
        try
        {
            await StopInternalAsync();
        }
        finally
        {
            _gate.Release();
        }
    }

    private Task StopInternalAsync()
    {
        _currentMode = "none";
        if (_discordWatchTimer != null)
        {
            _discordWatchTimer.Dispose();
            _discordWatchTimer = null;
        }
        StopRecorderOnly();
        return Task.CompletedTask;
    }

    private void StopRecorderOnly()
    {
        if (_recorder != null)
        {
            try
            {
                _recorder.DataAvailable -= OnWasapiDataAvailable;
                _recorder.StopRecording();
                _recorder.Dispose();
            }
            catch
            {
            }
            _recorder = null;
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_discordWatchTimer != null)
        {
            _discordWatchTimer.Dispose();
            _discordWatchTimer = null;
        }
        StopRecorderOnly();
        _gate.Dispose();
    }
}
