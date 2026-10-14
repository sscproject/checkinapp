const $ = id => document.getElementById(id);
let PIN = sessionStorage.getItem('pin') || '';
let people = [];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', 'x-admin-pin': PIN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) { sessionStorage.removeItem('pin'); location.reload(); throw new Error('auth'); }
  return r.json();
}

// ---------- login ----------
async function login() {
  PIN = $('pin').value.trim() || PIN;
  const r = await fetch('/api/admin/participants', { headers: { 'x-admin-pin': PIN } });
  if (r.status === 401 || r.status === 429) { $('loginErr').textContent = (await r.json().catch(() => ({}))).error || 'Wrong PIN'; sessionStorage.removeItem('pin'); return; }
  sessionStorage.setItem('pin', PIN);
  $('login').classList.add('hidden'); $('app').classList.remove('hidden');
  const d = await r.json();
  setupQr(d);
  render(d.participants);
  setInterval(refresh, 5000);
}
$('loginBtn').onclick = login;
$('pin').addEventListener('keydown', e => e.key === 'Enter' && login());
if (PIN) login();

async function refresh() { const d = await api('/api/admin/participants'); render(d.participants); }

// ---------- table ----------
function render(list) {
  people = list;
  const inList = list.filter(p => p.checkedInAt);
  $('sTotal').textContent = list.filter(p => !p.walkIn).length;
  $('sIn').textContent = inList.length;
  $('sWalk').textContent = list.filter(p => p.walkIn).length;
  const f = $('filter').value.toLowerCase(), show = $('show').value;
  const rows = list
    .filter(p => show === 'all' || (show === 'in') === !!p.checkedInAt)
    .filter(p => !f || [p.firstName, p.lastName, p.organisation, p.email, p.role].join(' ').toLowerCase().includes(f))
    .sort((a, b) => (b.checkedInAt || '').localeCompare(a.checkedInAt || '') || (a.lastName || '').localeCompare(b.lastName || ''));
  $('tbody').innerHTML = rows.map(p => `<tr>
    <td><span class="pill ${p.checkedInAt ? 'in' : 'no'}">${p.checkedInAt ? 'Checked in' : 'Not yet'}</span>${p.walkIn ? '<span class="pill walk">Walk-in</span>' : ''}</td>
    <td>${esc(p.firstName)}</td><td>${esc(p.lastName)}</td><td>${esc(p.role)}</td><td>${esc(p.organisation)}</td>
    <td>${esc(p.email)}</td><td>${esc(p.phone)}</td><td>${esc(p.gender)}</td>
    <td>${esc(p.consentWhatsapp)}</td><td>${esc(p.consentPhoto)}</td>
    <td>${p.checkedInAt ? new Date(p.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</td>
    <td>${p.checkedInAt ? `<button data-undo="${esc(p.id)}">Undo</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="12" class="muted">No participants yet — upload a registration list.</td></tr>';
}
$('filter').oninput = () => render(people);
$('show').onchange = () => render(people);
$('tbody').onclick = async e => {
  const id = e.target.dataset.undo;
  if (id && confirm('Undo this check-in?')) { await api('/api/admin/undo', { id }); refresh(); }
};
$('resetIns').onclick = async () => {
  const n = people.filter(p => p.checkedInAt).length;
  if (!confirm(`Clear ALL ${n} check-ins, consent answers and walk-ins?\nThe registration list is kept.`)) return;
  await api('/api/admin/reset-checkins', {});
  refresh();
};
$('clearAll').onclick = async () => {
  if (prompt('This deletes ALL participants and check-ins. Type DELETE to confirm.') === 'DELETE') { await api('/api/admin/clear', {}); refresh(); }
};

// ---------- upload ----------
const HEADER_MAP = {
  firstName: ['first name', 'firstname', 'given name', 'first'],
  lastName: ['last name', 'lastname', 'surname', 'family name', 'last'],
  role: ['designation/role', 'designation', 'role', 'position', 'title', 'job title'],
  organisation: ['organisation/country', 'organization/country', 'organisation', 'organization', 'country', 'org'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'phone number', 'contact number'],
  gender: ['gender'],
};
function mapRow(raw) {
  const keys = Object.keys(raw).reduce((m, k) => (m[k.toLowerCase().trim()] = raw[k], m), {});
  const out = {};
  for (const [field, names] of Object.entries(HEADER_MAP)) {
    const k = names.find(n => keys[n] !== undefined && keys[n] !== '');
    out[field] = k ? String(keys[k]).trim() : '';
  }
  // allow a single "Full Name" / "Name" column
  if (!out.firstName && !out.lastName && (keys['full name'] || keys['name'])) {
    const parts = String(keys['full name'] || keys['name']).trim().split(/\s+/);
    out.firstName = parts.shift(); out.lastName = parts.join(' ');
  }
  return out;
}
// Errors we write ourselves may contain markup; anything else is escaped before display
const fail = html => Object.assign(new Error(html), { safeHtml: true });
function status(kind, html) { $('msg').className = kind; $('msg').innerHTML = html; }
$('file').onchange = () => {
  const f = $('file').files[0];
  if (f) status('info', `Selected <b>${esc(f.name)}</b> (${Math.round(f.size / 1024)} KB). Click <b>Upload</b> to import.`);
};
$('upload').onclick = async () => {
  const file = $('file').files[0];
  if (!file) return status('bad', 'Please choose a file first (Excel .xlsx or .csv).');
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return status('bad', `<b>${esc(file.name)}</b> is not an Excel or CSV file.`);
  if (typeof XLSX === 'undefined') return status('bad', 'The spreadsheet reader did not load. Refresh the page (Ctrl+F5) and try again.');
  const mode = $('mode').value;
  if (mode === 'replace' && !confirm('Replace the whole list? Existing check-ins will be lost.')) return;

  const btn = $('upload');
  btn.disabled = true; btn.textContent = 'Uploading…';
  try {
    // 1. read the file
    status('info', `<span class="spin"></span>Step 1 of 2 — Reading <b>${esc(file.name)}</b>…`);
    let wb;
    try { wb = XLSX.read(await file.arrayBuffer()); }
    catch (e) { throw fail('Could not read this file. Is it open in Excel or password-protected? Save a copy as .xlsx or .csv and try again.'); }
    const sheetName = wb.SheetNames[0];
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '', raw: false });
    if (!raw.length) throw fail(`The first sheet ("${esc(sheetName)}") is empty. Put the participant list on the first sheet.`);
    const headers = Object.keys(raw[0]);
    const rows = raw.map(mapRow).filter(r => r.firstName || r.lastName);
    if (!rows.length) throw fail(`No names found. The columns found were: <b>${headers.map(esc).join(', ')}</b>.<br>The sheet needs <b>First Name</b> and <b>Last Name</b> columns (use <b>Download template</b> to see the format).`);

    // 2. send to server
    status('info', `<span class="spin"></span>Step 2 of 2 — Saving ${rows.length} participants…`);
    const r = await fetch('/api/admin/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-pin': PIN },
      body: JSON.stringify({ rows, mode }),
    }).catch(() => { throw fail('Could not reach the server. Is the check-in app still running?'); });
    if (r.status === 401) throw fail('Your admin session has expired. Refresh the page and log in again.');
    const res = await r.json().catch(() => ({}));
    if (!r.ok) throw fail(esc(res.error || `Server error (${r.status}).`));

    // summary
    const count = f => rows.filter(x => !x[f]).length;
    const gaps = [['Email', 'email'], ['Phone', 'phone'], ['Gender', 'gender'], ['Role', 'role'], ['Organisation/Country', 'organisation']]
      .map(([label, f]) => [label, count(f)]).filter(([, n]) => n);
    const skipped = raw.length - rows.length;
    status('ok', `✔ <b>Upload complete</b> — ${esc(file.name)} (sheet "${esc(sheetName)}")
      <ul>
        <li>${res.added} new participants added${res.updated ? `, ${res.updated} existing updated` : ''}</li>
        <li>Total in system: <b>${res.total}</b></li>
        ${skipped ? `<li>${skipped} blank row(s) skipped</li>` : ''}
        ${gaps.length ? `<li>Missing in file (participants will fill in at check-in): ${gaps.map(([l, n]) => `${l} ×${n}`).join(', ')}</li>` : ''}
      </ul>`);
    $('file').value = '';
    refresh();
  } catch (e) {
    status('bad', `✖ <b>Upload failed.</b> ${e.safeHtml ? e.message : esc(e.message)}`);
  } finally {
    btn.disabled = false; btn.textContent = 'Upload';
  }
};
$('tmpl').onclick = () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['First Name', 'Last Name', 'Designation/Role', 'Organisation/Country', 'Email', 'Phone', 'Gender'],
    ['Maria', 'Santos', 'Program Manager', 'Ministry of Health / Philippines', 'maria.santos@example.org', '', ''],
  ]);
  ws['!cols'] = [14, 14, 22, 32, 30, 16, 12].map(w => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Registrations');
  XLSX.writeFile(wb, 'registration-template.xlsx');
};

// ---------- export ----------
const COLS = [
  ['First Name', 'firstName'], ['Last Name', 'lastName'], ['Designation/Role', 'role'], ['Organisation/Country', 'organisation'],
  ['Email', 'email'], ['Phone', 'phone'], ['Gender', 'gender'], ['WhatsApp Group Consent', 'consentWhatsapp'],
  ['Photo/Social Media Consent', 'consentPhoto'], ['Walk-in', p => p.walkIn ? 'Yes' : 'No'],
  ['Checked In', p => p.checkedInAt ? 'Yes' : 'No'], ['Check-in Time', p => p.checkedInAt ? new Date(p.checkedInAt).toLocaleString() : ''],
];
// Stop participant-typed text like "=HYPERLINK(...)" running as a formula when the export is opened in Excel
const safeCell = v => /^[=@\t\r]|^[+-](?![\d\s])/.test(String(v)) ? "\x27" + v : v;
function exportRows(onlyIn) {
  return people.filter(p => !onlyIn || p.checkedInAt)
    .map(p => Object.fromEntries(COLS.map(([h, k]) => [h, safeCell(typeof k === 'function' ? k(p) : (p[k] || ''))])));
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
function exportXlsx(onlyIn) {
  const ws = XLSX.utils.json_to_sheet(exportRows(onlyIn), { header: COLS.map(c => c[0]) });
  ws['!cols'] = COLS.map(() => ({ wch: 20 }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, onlyIn ? 'Checked In' : 'All Participants');
  XLSX.writeFile(wb, `${onlyIn ? 'checked-in' : 'all-participants'}-${stamp()}.xlsx`);
}
$('exportXlsx').onclick = () => exportXlsx(true);
$('exportAll').onclick = () => exportXlsx(false);
$('exportCsv').onclick = () => {
  const ws = XLSX.utils.json_to_sheet(exportRows(true), { header: COLS.map(c => c[0]) });
  const blob = new Blob(['﻿' + XLSX.utils.sheet_to_csv(ws)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `checked-in-${stamp()}.csv`; a.click();
};

// ---------- QR ----------
function setupQr(d) {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  const opts = [];
  if (d.publicUrl) opts.push(d.publicUrl);
  if (!local) opts.push(location.origin + '/');
  opts.push(...d.urls);
  if (!opts.length) opts.push(location.origin + '/');
  $('urlPick').innerHTML = [...new Set(opts)].map(u => `<option>${esc(u)}</option>`).join('');
  $('urlPick').onchange = drawQr;
  drawQr();
}
function drawQr() {
  const url = $('urlPick').value;
  $('qr').innerHTML = '';
  new QRCode($('qr'), { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  $('qrLink').href = url; $('qrLink').textContent = url;
}
$('printQr').onclick = () => {
  const img = $('qr').querySelector('img')?.src || $('qr').querySelector('canvas')?.toDataURL();
  const w = window.open('');
  w.document.write(`<div style="text-align:center;font-family:sans-serif;padding-top:60px"><h2 style="font-size:26px;color:#0b5394">Asia-Pacific Digital Health Interoperability Bootcamp 2026</h2><h1 style="font-size:42px">Scan to Check in</h1><img src="${img}" style="width:420px;image-rendering:pixelated"><p style="font-size:22px">${esc($('urlPick').value)}</p></div>`);
  w.document.close(); setTimeout(() => w.print(), 300);
};
setInterval(() => $('clock').textContent = new Date().toLocaleTimeString(), 1000);
