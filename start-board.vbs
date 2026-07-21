Option Explicit

Dim shell, fso, scriptPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "scripts\start-board.js")
command = "cmd.exe /d /c node """ & scriptPath & """"

' 隐藏窗口、立即返回，适合双击启动常驻服务。
shell.Run command, 0, False
