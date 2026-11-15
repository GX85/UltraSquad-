'use strict';

const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

async function powershell(command, timeout) {
  const binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(binary, ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; " + command],
  { windowsHide: true, timeout, maxBuffer: 256 * 1024 });
  return stdout.trim();
}

function createMonitor(onChange) {
  const status = {
    available: null, realtime: null, activeThreats: null, knownThreats: null,
    checkedAt: null, scan: 'idle', scanAt: null, error: '', scanError: ''
  };
  let reading;
  let threatKey;
  const snapshot = () => ({ ...status });

  async function read() {
    try {
      if (process.platform !== 'win32') throw new Error('Microsoft Defender доступен на Windows.');
      const output = await powershell(`
        $s = Get-MpComputerStatus
        $threats = @(Get-MpThreat | Where-Object { $null -ne $_ })
        $active = @($threats | Where-Object IsActive)
        @{ available = [bool]$s.AntivirusEnabled
           realtime = [bool]$s.RealTimeProtectionEnabled
           knownThreats = $threats.Count
           activeThreats = $active.Count
           activeIds = @($active | ForEach-Object { [string]$_.ThreatID }) } | ConvertTo-Json -Compress
      `, 20000);
      const { activeIds, ...values } = JSON.parse(output);
      const key = JSON.stringify([values.available, values.realtime, values.knownThreats, [...activeIds].sort()]);
      const changed = key !== threatKey;
      threatKey = key;
      Object.assign(status, values, { checkedAt: Date.now(), error: '' });
      onChange(snapshot(), changed);
    } catch (error) {
      const changed = threatKey !== 'unavailable';
      threatKey = 'unavailable';
      Object.assign(status, {
        available: null, realtime: null, activeThreats: null, knownThreats: null,
        checkedAt: Date.now(), error: process.platform === 'win32'
          ? 'Не удалось прочитать статус Defender. Проверь службу и права Windows.'
          : error.message
      });
      onChange(snapshot(), changed);
    }
    return snapshot();
  }

  function refresh() {
    if (!reading) reading = read().finally(() => { reading = undefined; });
    return reading;
  }

  function scan() {
    if (status.scan === 'running') return snapshot();
    if (!status.available) return { ...snapshot(), error: status.error || 'Defender пока недоступен.' };
    Object.assign(status, { scan: 'running', scanAt: Date.now(), scanError: '' });
    onChange(snapshot(), false);
    void powershell('Start-MpScan -ScanType QuickScan', 20 * 60_000).then(
      () => { status.scan = 'submitted'; },
      () => {
        status.scan = 'error';
        status.scanError = 'Defender не подтвердил запуск. Проверь права или открой «Безопасность Windows».';
      }
    ).finally(() => {
      onChange(snapshot(), false);
      void refresh();
    });
    return snapshot();
  }

  return { snapshot, refresh, scan };
}

module.exports = { createMonitor };
