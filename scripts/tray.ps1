# Windows tray companion for Service Runner.
# Left-click opens the control panel. Right-click rebuilds the menu from the API.
param(
  [Parameter(Mandatory = $true)][string]$BaseUrl,
  [string]$Token = "",
  [string]$IconPath = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)

$script:RunnerBase = $BaseUrl.TrimEnd("/")
$script:RunnerToken = $Token

function Invoke-Api {
  param([string]$Method, [string]$Path)
  $headers = @{ "Accept" = "application/json" }
  if ($script:RunnerToken) { $headers["Authorization"] = "Bearer $script:RunnerToken" }
  try {
    return Invoke-RestMethod -Uri ($script:RunnerBase + $Path) -Method $Method -Headers $headers -TimeoutSec 8
  } catch {
    return $null
  }
}

function Open-Home {
  Start-Process ($script:RunnerBase + "/")
}

function Open-Dashboard {
  param([string]$Hash = "")
  $url = $script:RunnerBase + "/dashboard.html"
  if ($Hash) { $url = $url + "#" + $Hash }
  Start-Process $url
}

function Bind-ApiClick {
  param([string]$Method, [string]$Path)
  return { Invoke-Api $Method $Path }.GetNewClosure()
}

function Bind-Open {
  param([string]$Hash)
  return { Open-Dashboard $Hash }.GetNewClosure()
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Service Runner"
$notify.Visible = $true

if ($IconPath -and (Test-Path $IconPath)) {
  try {
    $notify.Icon = New-Object System.Drawing.Icon($IconPath)
  } catch {
    try {
      $bmp = New-Object System.Drawing.Bitmap($IconPath)
      $notify.Icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
    } catch {
      $notify.Icon = [System.Drawing.SystemIcons]::Application
    }
  }
} else {
  $notify.Icon = [System.Drawing.SystemIcons]::Application
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$menu.ShowImageMargin = $false
$notify.ContextMenuStrip = $menu

function Add-Disabled([string]$text) {
  $item = New-Object System.Windows.Forms.ToolStripMenuItem
  $item.Text = $text
  $item.Enabled = $false
  [void]$menu.Items.Add($item)
}

$menu.add_Opening({
  # $HOME is a read-only automatic variable in PowerShell — never assign to it.
  try {
    Rebuild-TrayMenu
  } catch {
    $menu.Items.Clear()
    Add-Disabled ("tray error: " + $_.Exception.Message)
  }
})

function Rebuild-TrayMenu {
  $menu.Items.Clear()

  $openHome = New-Object System.Windows.Forms.ToolStripMenuItem
  $openHome.Text = "Open home"
  $openHome.add_Click({ Open-Home })
  [void]$menu.Items.Add($openHome)
  $openDash = New-Object System.Windows.Forms.ToolStripMenuItem
  $openDash.Text = "Open dashboard"
  $openDash.add_Click({ Open-Dashboard })
  [void]$menu.Items.Add($openDash)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $data = Invoke-Api GET "/api/v1/tray"
  if (-not $data) {
    Add-Disabled "(cannot reach Service Runner)"
  } else {
    if ($data.groups -and @($data.groups).Count -gt 0) {
      $groupsMenu = New-Object System.Windows.Forms.ToolStripMenuItem
      $groupsMenu.Text = "Groups"
      foreach ($g in @($data.groups)) {
        $gid = [string]$g.id
        $sub = New-Object System.Windows.Forms.ToolStripMenuItem
        $sub.Text = "{0}  ({1}/{2})" -f $g.name, $g.running, $g.total

        $start = New-Object System.Windows.Forms.ToolStripMenuItem
        $start.Text = "Start group"
        $start.add_Click((Bind-ApiClick POST "/api/v1/groups/$gid/start"))

        $stop = New-Object System.Windows.Forms.ToolStripMenuItem
        $stop.Text = "Stop group"
        $stop.add_Click((Bind-ApiClick POST "/api/v1/groups/$gid/stop"))

        [void]$sub.DropDownItems.Add($start)
        [void]$sub.DropDownItems.Add($stop)
        [void]$groupsMenu.DropDownItems.Add($sub)
      }
      [void]$menu.Items.Add($groupsMenu)
      [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    }

    $services = @($data.services)
    if ($services.Count -gt 0) {
      foreach ($s in $services) {
        $sid = [string]$s.id
        $dot = switch ([string]$s.status) {
          "running"  { [char]0x25CF }
          "starting" { [char]0x25D0 }
          "stopping" { [char]0x25D0 }
          "crashed"  { [char]0x2716 }
          default    { [char]0x25CB }
        }
        $sub = New-Object System.Windows.Forms.ToolStripMenuItem
        $sub.Text = "{0}  {1}  {2}" -f $dot, $s.name, $s.status

        $openS = New-Object System.Windows.Forms.ToolStripMenuItem
        $openS.Text = "Open in control panel"
        $openS.add_Click((Bind-Open $sid))

        $startS = New-Object System.Windows.Forms.ToolStripMenuItem
        $startS.Text = "Start"
        $startS.add_Click((Bind-ApiClick POST "/api/v1/services/$sid/start"))

        $stopS = New-Object System.Windows.Forms.ToolStripMenuItem
        $stopS.Text = "Stop"
        $stopS.add_Click((Bind-ApiClick POST "/api/v1/services/$sid/stop"))

        $restartS = New-Object System.Windows.Forms.ToolStripMenuItem
        $restartS.Text = "Restart"
        $restartS.add_Click((Bind-ApiClick POST "/api/v1/services/$sid/restart"))

        [void]$sub.DropDownItems.Add($openS)
        [void]$sub.DropDownItems.Add($startS)
        [void]$sub.DropDownItems.Add($stopS)
        [void]$sub.DropDownItems.Add($restartS)
        [void]$menu.Items.Add($sub)
      }
      [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    } else {
      Add-Disabled "No services yet"
      [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
    }
  }

  $stopAll = New-Object System.Windows.Forms.ToolStripMenuItem
  $stopAll.Text = "Stop all services"
  $stopAll.add_Click({ Invoke-Api POST "/api/v1/stop-all" })
  [void]$menu.Items.Add($stopAll)

  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

  $quit = New-Object System.Windows.Forms.ToolStripMenuItem
  $quit.Text = "Quit Service Runner"
  $quit.add_Click({
    Invoke-Api POST "/api/v1/shutdown"
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  })
  [void]$menu.Items.Add($quit)
}

$notify.add_MouseUp({
  param($sender, $e)
  if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Open-Home
  }
})

$notify.add_DoubleClick({ Open-Home })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 4000
$timer.add_Tick({
  $h = Invoke-Api GET "/api/v1/health"
  if (-not $h) {
    $notify.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

$context = New-Object System.Windows.Forms.ApplicationContext
try {
  [System.Windows.Forms.Application]::Run($context)
} finally {
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
}
