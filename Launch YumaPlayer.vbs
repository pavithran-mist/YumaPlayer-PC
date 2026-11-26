Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
exePath = baseDir & "\node_modules\electron\dist\electron.exe"
WshShell.Run Chr(34) & exePath & Chr(34) & " " & Chr(34) & baseDir & Chr(34), 0, False
