' EasyBrowse guardian launcher (invoked by scheduled task easybrowse-app)
'
' Purpose : start the Node service with no window, and bring it back up when it dies.
' Behavior: exit code 0  -> treated as an intentional stop, guardian exits.
'           non-zero     -> treated as a crash, restart with backoff
'                           (5s,10s,20s,40s,60s cap), give up after 20 attempts.
' Mode    : decided by the service itself, not here. Priority:
'             1) NOWAPI_ONLY from the environment (set by the .bat launchers)
'             2) data\autostart-mode.txt, written by install-autostart.ps1 -Mode
'             3) default = full platform
'           Keeping the decision in config.js means this file stays ANSI-safe and
'           we never have to mutate the WSH process environment.
' Note    : comments are English on purpose - cscript reads this file as ANSI,
'           so UTF-8 Chinese comments would be garbled and can break parsing.
' Stop    : do NOT just kill node.exe, the guardian would restart it.
'           Use scripts\stop-service.ps1 (it stops the task instance first).
Option Explicit

Dim sh, fso, root, cmd, rc, fails, waitSec, logPath, logFile, stamp

Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = "C:\Users\Administrator\WorkBuddy\easyvpn"
sh.CurrentDirectory = root

If Not fso.FolderExists(root & "\data") Then fso.CreateFolder(root & "\data")
logPath = root & "\data\guardian.log"

cmd = "cmd /c ""D:\Ccode\NODE\node-v24.12.0-win-x64\node.exe"" --experimental-sqlite src\server.js >> data\server.log 2>&1"

fails = 0
Do
  rc = sh.Run(cmd, 0, True)
  stamp = Now
  If rc = 0 Then
    WriteLog stamp & "  service exited normally (code 0), guardian stops."
    Exit Do
  End If
  fails = fails + 1
  WriteLog stamp & "  service exited with code " & rc & " (restart attempt " & fails & ")"
  If fails >= 20 Then
    WriteLog Now & "  too many restarts, guardian gives up. check data\server.log"
    Exit Do
  End If
  waitSec = 5 * (2 ^ (fails - 1))
  If waitSec > 60 Then waitSec = 60
  WScript.Sleep waitSec * 1000
Loop

Sub WriteLog(msg)
  On Error Resume Next
  Set logFile = fso.OpenTextFile(logPath, 8, True)
  logFile.WriteLine msg
  logFile.Close
  On Error GoTo 0
End Sub
