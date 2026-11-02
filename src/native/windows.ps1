param(
    [Parameter(Mandatory=$true)][ValidateSet('ListWindows','CaptureLink','Capabilities','InspectQuestions')][string]$Action,
    [string]$PayloadBase64 = 'e30='
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

# Native calls are confined to a verified Codex desktop process and the exact
# selected window identity. This helper never types or submits chat messages.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class CodexTimerWindows {
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder information, uint length, out uint needed);
    [DllImport("oleacc.dll")] public static extern int AccessibleObjectFromWindow(IntPtr window, uint objectId, ref Guid interfaceId, [MarshalAs(UnmanagedType.Interface)] out object accessible);
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint data; public uint flags; public uint time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public MOUSEINPUT mouse; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION union; }
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] input, int size);
    public static bool IsInteractiveDesktop() {
        IntPtr desktop = OpenInputDesktop(0, false, 1); if (desktop == IntPtr.Zero) return false;
        try { uint needed; var name = new StringBuilder(256); return GetUserObjectInformation(desktop, 2, name, 512, out needed) && name.ToString().Equals("Default", StringComparison.OrdinalIgnoreCase); }
        finally { CloseDesktop(desktop); }
    }
    public static long[] TopWindows() {
        var list = new List<long>(); EnumProc callback = (window, parameter) => { if (IsWindowVisible(window)) list.Add(window.ToInt64()); return true; };
        EnumWindows(callback, IntPtr.Zero); GC.KeepAlive(callback); return list.ToArray();
    }
    public static bool CopyThreadLinkShortcut() {
        INPUT[] keys = new INPUT[6]; ushort[] codes = { 0x11, 0x12, 0x4C, 0x4C, 0x12, 0x11 };
        for (int index=0; index<keys.Length; index++) { keys[index].type=1; keys[index].union.keyboard.vk=codes[index]; keys[index].union.keyboard.flags=index>=3?2u:0u; }
        uint sent=SendInput((uint)keys.Length,keys,Marshal.SizeOf(typeof(INPUT)));
        if (sent != keys.Length) { INPUT[] release = new INPUT[3]; for(int i=0;i<3;i++){release[i].type=1;release[i].union.keyboard.vk=codes[2-i];release[i].union.keyboard.flags=2;} SendInput(3,release,Marshal.SizeOf(typeof(INPUT))); }
        return sent == keys.Length;
    }
    public static bool HasMarkers(string file, string[] markers) {
        if (!System.IO.File.Exists(file)) return false;
        var info=new System.IO.FileInfo(file);
        bool[] found=new bool[markers.Length]; var buffer=new byte[65536]; string carry="";
        using(var stream=System.IO.File.Open(file,System.IO.FileMode.Open,System.IO.FileAccess.Read,System.IO.FileShare.ReadWrite|System.IO.FileShare.Delete)){
            int count; long total=0; while(total<67108864 && (count=stream.Read(buffer,0,buffer.Length))>0){total+=count;string text=carry+Encoding.UTF8.GetString(buffer,0,count);bool all=true;for(int i=0;i<markers.Length;i++){found[i]=found[i]||text.Contains(markers[i]);all=all&&found[i];}if(all)return true;carry=text.Substring(Math.Max(0,text.Length-256));}
        } return false;
    }
}
'@

$script:TrustedExecutables = @{}
function Test-TrustedExecutable([string]$Executable) {
    if ($script:TrustedExecutables.ContainsKey($Executable)) { return $script:TrustedExecutables[$Executable] }
    $signature = Get-AuthenticodeSignature -LiteralPath $Executable
    $trusted = $signature.Status -eq 'Valid' -and $signature.SignerCertificate.Subject -match '(?:^|,\s*)(?:CN|O)="?OpenAI(?:\s|,|"|$)'
    $script:TrustedExecutables[$Executable] = $trusted
    return $trusted
}

function Get-CodexProcess([int]$ProcessId) {
    try {
        $candidate = Get-Process -Id $ProcessId -ErrorAction Stop
        if ($candidate.ProcessName -notin @('ChatGPT','Codex','codex')) { return $null }
        $executable = $candidate.Path
        if (-not $executable) { return $null }
        if (-not (Test-TrustedExecutable $executable)) { return $null }
        $protectedRoot = [regex]::Escape([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles))
        $packaged = $executable -match ('^'+$protectedRoot+'\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\(?:ChatGPT|Codex)\.exe$')
        if (-not $packaged) {
            $metadata = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
            if ($metadata.ProductName -notmatch 'Codex' -or $metadata.CompanyName -notmatch 'OpenAI') { return $null }
        }
        return [pscustomobject]@{ process=$candidate; id=$candidate.Id; started=$candidate.StartTime.ToUniversalTime().Ticks.ToString(); path=$executable; packaged=$packaged }
    } catch { return $null }
}

function Get-WindowIdentity([IntPtr]$Handle, $Owner) {
    return ('cw1.{0}.{1}.{2}' -f $Owner.id,$Owner.started,$Handle.ToInt64().ToString('x'))
}

function Get-CodexWindows {
    $owners = @{}
    foreach ($candidate in @(Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue)) {
        $owner = Get-CodexProcess $candidate.Id
        if ($null -ne $owner) { $owners[[int]$candidate.Id] = $owner }
    }
    $windows = [Collections.Generic.List[object]]::new()
    foreach ($number in [CodexTimerWindows]::TopWindows()) {
        $handle = [IntPtr]::new($number)
        [uint32]$ownerId = 0
        [void][CodexTimerWindows]::GetWindowThreadProcessId($handle,[ref]$ownerId)
        if (-not $owners.ContainsKey([int]$ownerId)) { continue }
        $title = [Text.StringBuilder]::new(1024)
        [void][CodexTimerWindows]::GetWindowText($handle,$title,$title.Capacity)
        if (-not $title.Length) { continue }
        $owner = $owners[[int]$ownerId]
        $windows.Add([pscustomobject]@{ id=(Get-WindowIdentity $handle $owner); title=$title.ToString(); handle=$handle; owner=$owner })
    }
    return $windows.ToArray()
}

function Resolve-CodexWindow([string]$Identity) {
    if ($Identity -notmatch '^cw1\.(\d+)\.(\d+)\.([0-9a-f]+)$') { throw '所选窗口标识无效，请重新选择 Codex 窗口' }
    $ownerId = [int]::Parse($Matches[1]); $started = $Matches[2]
    $handle = [IntPtr]::new([Convert]::ToInt64($Matches[3],16))
    if (-not [CodexTimerWindows]::IsWindow($handle)) { throw '所选 Codex 窗口已经关闭，请重新选择' }
    [uint32]$actualId = 0
    [void][CodexTimerWindows]::GetWindowThreadProcessId($handle,[ref]$actualId)
    if ($actualId -ne $ownerId) { throw '窗口进程已经改变，已阻止当前页面操作' }
    $owner = Get-CodexProcess $ownerId
    if ($null -eq $owner -or $owner.started -ne $started) { throw '所选 Codex 进程已重新启动，请重新绑定窗口' }
    if (-not [CodexTimerWindows]::IsWindowVisible($handle)) { throw '所选 Codex 窗口不可见，请恢复窗口后重试' }
    return [pscustomobject]@{ handle=$handle; owner=$owner; id=$Identity }
}

function Get-DesktopCapabilities($Window) {
    $reason = '尚无可验证的桌面待答请求提交接口；普通选择题请在 Codex 中处理。看守消息会预先附带决策规则，但不能解除已经阻塞的问题。'
    if ($null -eq $Window) { return @{ answerQuestion=$false; ordinaryQuestionReason=$reason; supportsWake=$false; version=$null } }
    $owner = $Window.owner
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($owner.path).ProductVersion
    if ($owner.packaged) {
        $manifest = Join-Path (Split-Path -Parent (Split-Path -Parent $owner.path)) 'AppxManifest.xml'
        if (Test-Path -LiteralPath $manifest) { $packageXml = [xml](Get-Content -LiteralPath $manifest -Raw); $version = $packageXml.Package.Identity.Version }
    }
    $asar = Join-Path (Split-Path -Parent $owner.path) 'resources\app.asar'
    $wake = $false
    if ($owner.packaged) { $wake = [CodexTimerWindows]::HasMarkers($asar,@('wakeQueuedThread','threadQueue','0.148.0-alpha.14')) }
    return @{ answerQuestion=$false; ordinaryQuestionReason=$reason; supportsWake=$wake; version=$version; identity= $(if($owner.packaged){'OpenAI.Codex'}else{'OpenAI signed Codex'}) }
}

function Get-QuestionAccessibility($Window) {
    # Trigger accessibility only for this window. No global screen-reader flag,
    # registry setting, application restart, or unsafe WM message is required.
    $interface = [Guid]'618736e0-3c3d-11cf-810c-00aa00389b71'
    $accessible = $null
    $msaaResult = [CodexTimerWindows]::AccessibleObjectFromWindow($Window.handle,[uint32]4294967292,[ref]$interface,[ref]$accessible)
    if ($null -ne $accessible -and [Runtime.InteropServices.Marshal]::IsComObject($accessible)) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($accessible) }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $root = [Windows.Automation.AutomationElement]::FromHandle($Window.handle)
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [Collections.Generic.Queue[object]]::new()
    if ($null -ne $root) { $queue.Enqueue($root) }
    $nodes = [Collections.Generic.List[object]]::new(); $visited = 0
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    while ($queue.Count -gt 0 -and $visited -lt 600 -and [DateTime]::UtcNow -lt $deadline) {
        $element = $queue.Dequeue(); $visited++
        try {
            $current = $element.Current
            $kind = $current.ControlType.ProgrammaticName -replace '^ControlType\.',''
            if ($kind -in @('Button','Edit','RadioButton','CheckBox','ComboBox','ListItem')) {
                $label = $current.Name
                if ($label.Length -gt 200) { $label = $label.Substring(0,200) }
                $nodes.Add(@{ kind=$kind; name=$label; automationId=$current.AutomationId; enabled=$current.IsEnabled; offscreen=$current.IsOffscreen })
            }
            $child = $walker.GetFirstChild($element)
            while ($null -ne $child -and $queue.Count -lt 600) { $queue.Enqueue($child); $child = $walker.GetNextSibling($child) }
        } catch { }
    }
    return @{ visited=$visited; controls=$nodes.ToArray(); msaaResult=$msaaResult; answerQuestion=$false; reason='已执行所选窗口的 MSAA/UIA 只读检查；可访问性标签不提供桌面待答请求的稳定 requestId，不能据此安全自动提交。' }
}

try {
    if ($PayloadBase64.Length -gt 65536) { throw 'Windows 助手请求过长' }
    $payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadBase64)) | ConvertFrom-Json
    if ($Action -eq 'ListWindows') {
        $found = @(Get-CodexWindows)
        $public = @($found | ForEach-Object { @{ id=$_.id; title=$_.title } })
        @{ok=$true; windows=$public} | ConvertTo-Json -Compress -Depth 8
    } elseif ($Action -eq 'Capabilities') {
        $found = @(Get-CodexWindows)
        $selected = $null
        if ($found.Count -gt 0) { $selected = $found[0] }
        @{ok=$true; windows=@($found | ForEach-Object { @{id=$_.id;title=$_.title} }); desktop=(Get-DesktopCapabilities $selected)} | ConvertTo-Json -Compress -Depth 8
    } elseif ($Action -eq 'InspectQuestions') {
        $window = Resolve-CodexWindow $payload.windowId
        @{ok=$true; windowId=$window.id; inspection=(Get-QuestionAccessibility $window)} | ConvertTo-Json -Compress -Depth 8
    } elseif ($Action -eq 'CaptureLink') {
        $window = Resolve-CodexWindow $payload.windowId
        if (-not [CodexTimerWindows]::IsInteractiveDesktop()) { throw 'Windows 已锁定或处于安全桌面，请解锁后再关联当前页面' }
        foreach ($key in @(0x10,0x11,0x12,0x5B,0x5C)) { if (([CodexTimerWindows]::GetAsyncKeyState($key) -band 0x8000) -ne 0) { throw '检测到键盘修饰键仍被按住，请松开后重试' } }
        if ([CodexTimerWindows]::IsIconic($window.handle)) { [void][CodexTimerWindows]::ShowWindowAsync($window.handle,9) }
        [void][CodexTimerWindows]::SetForegroundWindow($window.handle)
        $focusDeadline = [DateTime]::UtcNow.AddMilliseconds(1200)
        while ([CodexTimerWindows]::GetForegroundWindow() -ne $window.handle -and [DateTime]::UtcNow -lt $focusDeadline) { Start-Sleep -Milliseconds 40 }
        if ([CodexTimerWindows]::GetForegroundWindow() -ne $window.handle) { throw '无法聚焦所选 Codex 窗口，已停止复制链接' }
        $sequence = [CodexTimerWindows]::GetClipboardSequenceNumber()
        [void](Resolve-CodexWindow $payload.windowId)
        if (-not [CodexTimerWindows]::CopyThreadLinkShortcut()) { throw '系统未接受复制当前聊天链接的快捷键' }
        Add-Type -AssemblyName System.Windows.Forms
        $captureDeadline = [DateTime]::UtcNow.AddMilliseconds(2500)
        $link = $null
        while ([DateTime]::UtcNow -lt $captureDeadline) {
            if ([CodexTimerWindows]::GetForegroundWindow() -ne $window.handle) { throw '复制期间前台窗口已经改变，已拒绝读取目标' }
            if ([CodexTimerWindows]::GetClipboardSequenceNumber() -ne $sequence) {
                try {
                    $candidate = [Windows.Forms.Clipboard]::GetText().Trim()
                    if ($candidate -match '^codex://threads/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$') { $link = $candidate; $threadId = $Matches[1].ToLowerInvariant(); break }
                } catch { }
            }
            Start-Sleep -Milliseconds 40
        }
        if (-not $link) { throw '未收到新鲜的 Codex 当前聊天链接。请确认选中了聊天页面且此版本支持 Ctrl+Alt+L' }
        [void](Resolve-CodexWindow $payload.windowId)
        @{ok=$true; windowId=$window.id; threadId=$threadId; link=('codex://threads/'+$threadId)} | ConvertTo-Json -Compress
    }
    exit 0
} catch {
    @{ok=$false; code='INVALID_TARGET'; message=$_.Exception.Message} | ConvertTo-Json -Compress
    exit 1
}
