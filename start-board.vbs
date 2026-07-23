Option Explicit

Dim shell, fso, scriptPath, tempPath, command, exitCode, message

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptPath = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "scripts\start-board.js")
tempPath = fso.BuildPath(fso.GetSpecialFolder(2), "cursor-board-start.log")
command = "cmd.exe /d /c node """ & scriptPath & """ > """ & tempPath & """ 2>&1"

' Run the launcher without a visible window and wait for its result.
exitCode = shell.Run(command, 0, True)

message = ReadUtf8(tempPath)
If fso.FileExists(tempPath) Then fso.DeleteFile tempPath

If exitCode = 0 Then
  If message = "" Then message = "Cursor Board started in the background."
  MsgBox message, vbInformation + vbSystemModal, "Cursor Board started"
Else
  If message = "" Then message = "Startup failed. Exit code: " & exitCode
  MsgBox message, vbCritical + vbSystemModal, "Cursor Board startup failed"
End If

' Read the launcher output as UTF-8.
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
