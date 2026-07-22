Option Explicit

Dim shell, fso, scriptPath, tempPath, command, exitCode, message

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "scripts\start-board.js")
tempPath = fso.BuildPath(fso.GetSpecialFolder(2), "cursor-board-start.log")
command = "cmd.exe /d /c node """ & scriptPath & """ > """ & tempPath & """ 2>&1"

' 隐藏窗口执行启动脚本并等待其退出；脚本会把服务转入后台常驻，随后弹窗告知启动结果。
exitCode = shell.Run(command, 0, True)

message = ReadUtf8(tempPath)
If fso.FileExists(tempPath) Then fso.DeleteFile tempPath

If exitCode = 0 Then
  If message = "" Then message = "Cursor Board 已在后台启动并持续运行。"
  MsgBox message, vbInformation + vbSystemModal, "Cursor Board 启动成功"
Else
  If message = "" Then message = "启动失败，退出码：" & exitCode
  MsgBox message, vbCritical + vbSystemModal, "Cursor Board 启动失败"
End If

' 以 UTF-8 读取启动脚本输出，避免中文乱码。
Function ReadUtf8(filePath)
  ReadUtf8 = ""
  If Not fso.FileExists(filePath) Then Exit Function
  Dim stream
  On Error Resume Next
  Set stream = CreateObject("ADODB.Stream")
  stream.Type = 2
  stream.Charset = "utf-8"
  stream.Open
  stream.LoadFromFile filePath
  ReadUtf8 = Trim(stream.ReadText)
  stream.Close
  On Error GoTo 0
End Function
