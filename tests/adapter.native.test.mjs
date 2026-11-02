import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { callNative } from '../src/adapters/process.mjs';

test('Windows helper pins PID, start time and handle and requires a fresh clipboard sequence', async () => {
  const script = await readFile(new URL('../src/native/windows.ps1', import.meta.url), 'utf8');
  assert.equal(script.charCodeAt(0), 0xFEFF, 'Windows PowerShell 5 requires a UTF-8 BOM for Chinese messages');
  assert.match(script, /EnumWindows/u); assert.match(script, /StartTime/u); assert.match(script, /GetWindowThreadProcessId/u);
  assert.match(script, /GetClipboardSequenceNumber/u); assert.match(script, /SetForegroundWindow/u); assert.match(script, /OpenInputDesktop/u);
  assert.match(script, /AccessibleObjectFromWindow/u);
  assert.doesNotMatch(script, /SPI_SETSCREENREADER|SystemParametersInfo|SendKeys|mouse_event|SetCursorPos|Invoke-Expression|\biex\b/iu);
  assert.match(script, /ordinaryQuestionReason/u);
  assert.match(script, /TrustedExecutable/u, 'packaged paths also require verified OpenAI signature');
});
test('real Windows PowerShell child does not load an incompatible inherited signature module', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'codex-timer-module-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modules = path.join(directory, 'modules');
  const shadow = path.join(modules, 'Microsoft.PowerShell.Security'); await mkdir(shadow, { recursive: true });
  await writeFile(path.join(shadow, 'Microsoft.PowerShell.Security.psd1'), "@{ModuleVersion='99.0.0';GUID='65cb4300-e103-4e79-92bf-c7056b9dbbc1';RootModule='Microsoft.PowerShell.Security.psm1';FunctionsToExport=@('Get-AuthenticodeSignature')}\n");
  await writeFile(path.join(shadow, 'Microsoft.PowerShell.Security.psm1'), "function Get-AuthenticodeSignature { throw 'SYNTHETIC_INCOMPATIBLE_POWERSHELL_MODULE' }; Export-ModuleMember -Function Get-AuthenticodeSignature\n");
  const script = path.join(directory, 'readonly-module-probe.ps1');
  await writeFile(script, '\uFEFF' + `param([string]$Action,[string]$PayloadBase64)\n$ErrorActionPreference='Stop'\n[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)\ntry {\n  $signature = Get-AuthenticodeSignature -LiteralPath ([Diagnostics.Process]::GetCurrentProcess().MainModule.FileName)\n  @{ok=$true;modulePath=(Get-Module Microsoft.PowerShell.Security).Path;signatureStatus=$signature.Status.ToString()} | ConvertTo-Json -Compress\n  exit 0\n} catch {\n  @{ok=$false;message=$_.Exception.Message} | ConvertTo-Json -Compress\n  exit 1\n}\n`);
  const result = await callNative(script, 'ListWindows', {}, { env: { ...process.env, PSModulePath: modules } });
  const osModules = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  assert.ok(result.modulePath.toLowerCase().startsWith(osModules.toLowerCase()));
  assert.equal(result.signatureStatus, 'Valid');
});
