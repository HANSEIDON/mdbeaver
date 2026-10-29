# Registers two logon tasks for the current user that keep the GPU path running:
#   "mdbeaver mineru" -> worker/run-mineru.cmd (MinerU API in WSL)
#   "mdbeaver worker" -> worker/run-worker.cmd (pulls jobs from mdbeaver.com)
# Both run hidden (conhost --headless) and restart themselves when they exit.
# Re-run to update; remove with: Unregister-ScheduledTask -TaskName "mdbeaver *" -Confirm:$false
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$user = "$env:USERDOMAIN\$env:USERNAME"

foreach ($t in @(@{ Name = "mdbeaver mineru"; Script = "run-mineru.cmd" },
                 @{ Name = "mdbeaver worker"; Script = "run-worker.cmd" })) {
    $action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless cmd.exe /c `"$here\$($t.Script)`"" -WorkingDirectory $here
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Settings $settings `
        -Principal $principal -Force | Out-Null
    "registered: $($t.Name)"
}
