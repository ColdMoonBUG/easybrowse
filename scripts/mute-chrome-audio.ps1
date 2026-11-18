# Mute the Windows audio sessions of a Chrome process tree.
#
# Why: remote browsers run on the host machine, so their audio comes out of the
# host speakers - any user playing a video is heard by the administrator.
# New instances are started with --mute-audio; this script handles instances
# that are already running (or whose audio session gets re-created).
#
# Usage:
#   powershell -NoProfile -File mute-chrome-audio.ps1 -RootPids 1234,5678
#   powershell -NoProfile -File mute-chrome-audio.ps1 -AllChrome
#   powershell -NoProfile -File mute-chrome-audio.ps1 -RootPids 1234 -Status
# Output: {"targets":N,"sessions":["pid:True"]}

param(
  [string]$RootPids = '',
  [string]$ProfileRoot = '',
  [switch]$AllChrome,
  [switch]$Status,
  [switch]$ListAll
)

$ErrorActionPreference = 'Stop'

# -File passes arrays awkwardly, so accept a string and split it here
$pids = @()
if ($RootPids) {
  $pids = @($RootPids -split '[,;\s]+' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })
}

$cs = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace EasyBrowseAudio
{
    internal enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(EDataFlow dataFlow, int stateMask, out IMMDeviceCollection devices);
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, int role, out IMMDevice endpoint);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        int RegisterEndpointNotificationCallback(IntPtr client);
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }

    [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceCollection
    {
        int GetCount(out int count);
        int Item(int index, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                     [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        int OpenPropertyStore(int access, out IntPtr properties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetState(out int state);
    }

    [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr audioSessionGuid, int streamFlags, out IntPtr sessionControl);
        int GetSimpleAudioVolume(IntPtr audioSessionGuid, int streamFlags, out IntPtr audioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnum);
        int RegisterSessionNotification(IntPtr sessionNotification);
        int UnregisterSessionNotification(IntPtr sessionNotification);
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr duckNotification);
        int UnregisterDuckNotification(IntPtr duckNotification);
    }

    [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl2 session);
    }

    [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        int GetState(out int state);
        int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string value, ref Guid eventContext);
        int GetGroupingParam(out Guid groupingParam);
        int SetGroupingParam(ref Guid groupingParam, ref Guid eventContext);
        int RegisterAudioSessionNotification(IntPtr newNotifications);
        int UnregisterAudioSessionNotification(IntPtr newNotifications);
        int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
        int GetProcessId(out uint processId);
        int IsSystemSoundsSession();
        int SetDuckingPreference(bool optOut);
    }

    [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    public static class AudioMuter
    {
        const int DEVICE_STATE_ACTIVE = 0x1;
        const int CLSCTX_ALL = 0x17;

        // Mute (mute=true) or only read the state of every session owned by pids.
        public static string[] Apply(int[] pids, bool mute)
        {
            var results = new List<string>();
            if (pids == null || pids.Length == 0) return results.ToArray();
            var wanted = new HashSet<uint>();
            foreach (int p in pids) wanted.Add((uint)p);

            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(EDataFlow.eRender, DEVICE_STATE_ACTIVE, out devices) != 0) return results.ToArray();
            int deviceCount;
            devices.GetCount(out deviceCount);

            for (int i = 0; i < deviceCount; i++)
            {
                IMMDevice device;
                devices.Item(i, out device);
                if (device == null) continue;

                Guid iid = typeof(IAudioSessionManager2).GUID;
                object raw;
                if (device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out raw) != 0) continue;
                var manager = raw as IAudioSessionManager2;
                if (manager == null) continue;

                IAudioSessionEnumerator sessions;
                if (manager.GetSessionEnumerator(out sessions) != 0 || sessions == null) continue;
                int count;
                sessions.GetCount(out count);
                for (int j = 0; j < count; j++)
                {
                    IAudioSessionControl2 ctl;
                    if (sessions.GetSession(j, out ctl) != 0 || ctl == null) continue;
                    uint pid;
                    if (ctl.GetProcessId(out pid) != 0) continue;
                    if (!wanted.Contains(pid)) continue;
                    var vol = ctl as ISimpleAudioVolume;
                    if (vol == null) { results.Add(pid.ToString() + ":novolume"); continue; }
                    Guid ctx = Guid.Empty;
                    if (mute) vol.SetMute(true, ref ctx);
                    bool muted;
                    vol.GetMute(out muted);
                    results.Add(pid.ToString() + ":" + muted.ToString());
                }
            }
            return results.ToArray();
        }
    }
}
'@

Add-Type -TypeDefinition $cs -ErrorAction Stop

# Only care about the Chrome process tree: roots + all descendants (the audio
# service runs as a child process, so matching the root pid alone is not enough)
$procs = @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine)
$childMap = @{}
foreach ($p in $procs) { $childMap[[int]$p.ProcessId] = [int]$p.ParentProcessId }

$targets = New-Object 'System.Collections.Generic.HashSet[int]'
if ($AllChrome) {
  foreach ($p in $procs) { [void]$targets.Add([int]$p.ProcessId) }
} else {
  foreach ($root in $pids) { [void]$targets.Add($root) }
  # Identify platform-owned Chrome by its profile dir, so orphan instances that are
  # no longer in the database (left over from an earlier run) get muted too.
  if ($ProfileRoot) {
    foreach ($p in $procs) {
      if ($p.CommandLine -and $p.CommandLine -like "*user-data-dir=*$ProfileRoot*") {
        [void]$targets.Add([int]$p.ProcessId)
      }
    }
  }
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($child in @($childMap.Keys)) {
      $parent = $childMap[$child]
      if ($targets.Contains($parent) -and -not $targets.Contains($child)) {
        [void]$targets.Add($child)
        $changed = $true
      }
    }
  }
}

$sessions = @()
$err = $null
if ($ListAll) {
  # Diagnostic mode: list every audio session on every render device
  try {
    $all = @(Get-Process | ForEach-Object { $_.Id })
    $targets = New-Object 'System.Collections.Generic.HashSet[int]'
    foreach ($x in $all) { [void]$targets.Add([int]$x) }
  } catch { $err = $_.Exception.Message }
}
if ($targets.Count -gt 0) {
  try {
    $arr = @($targets)
    $sessions = @([EasyBrowseAudio.AudioMuter]::Apply([int[]]$arr, (-not $Status)))
  } catch {
    # No active audio device (no sound card / headless RDP) - report and continue
    $err = $_.Exception.Message
    $sessions = @()
  }
}

@{ targets = $targets.Count; sessions = $sessions; error = $err } | ConvertTo-Json -Compress
