const $ = id => document.getElementById(id);
const FIELDS = ['firstName','lastName','role','organisation','email','phone','gender'];
const form = $('form');
let currentId = null;
let onFile = {}; // fields we already hold (shown masked) — may be left blank to keep

function show(step) {
  ['step-search','step-form','success'].forEach(s => $(s).classList.toggle('hidden', s !== step));
  window.scrollTo(0, 0);
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// ---- search (debounced) ----
let timer;
$('q').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(runSearch, 250);
});
async function runSearch() {
  const q = $('q').value.trim();
  $('results').innerHTML = '';
  $('noresults').classList.add('hidden');
  if (q.replace(/s/g, '').length < 3) return;
  const list = await fetch('/api/search?q=' + encodeURIComponent(q)).then(r => r.json()).catch(() => []);
  if (!list.length) {
    $('noresults').textContent = 'No match found. Check spelling or try just your first or last name.';
    $('noresults').classList.remove('hidden');
    return;
  }
  $('results').innerHTML = list.map(p =>
    `<button class="result" data-id="${esc(p.id)}"><span>${esc(p.firstName)} ${esc(p.lastName)}<small>${esc(p.organisation)}</small></span>${p.checkedIn ? '<span class="badge">Already checked in</span>' : ''}</button>`
  ).join('');
}
$('results').addEventListener('click', async e => {
  const btn = e.target.closest('.result');
  if (!btn) return;
  const rec = await fetch('/api/participant/' + btn.dataset.id).then(r => r.json());
  if (rec.checkedIn) {
    $('noresults').textContent = rec.firstName + ' ' + rec.lastName + ' is already checked in. If this is you, please go to the front desk.';
    $('noresults').classList.remove('hidden');
    return;
  }
  openForm(rec);
});
$('walkin').addEventListener('click', () => openForm(null));

// ---- form ----
function openForm(rec) {
  form.reset();
  currentId = rec ? rec.id : null;
  $('err').style.display = 'none';
  $('form-title').textContent = rec ? 'Please check your details' : 'New participant';
  $('form-sub').textContent = rec
    ? 'Correct anything that\'s wrong and fill in the highlighted fields. All fields are required.'
    : 'Please fill in your details. All fields are required.';
  if (!rec) {
    const parts = $('q').value.trim().split(/\s+/);
    rec = { firstName: parts.shift() || '', lastName: parts.join(' ') };
  }
  for (const f of FIELDS) form.elements[f].value = rec[f] || '';
  onFile = { email: rec.emailMasked || '', phone: rec.phoneMasked || '' };
  for (const f of ['email', 'phone']) {
    const what = f === 'email' ? 'email' : 'phone number';
    $(f + 'OnFile').innerHTML = onFile[f]
      ? `We have this ${what} for you:<span class="masked">${esc(onFile[f])}</span>If this is yours, leave the box empty. If not, type your correct ${what} above.`
      : '';
    form.elements[f].placeholder = onFile[f] ? (f === 'email' ? 'Type a different email (optional)' : 'Type a different number (optional)') : (f === 'phone' ? 'Include country code, e.g. +61 4…' : '');
  }
  if (rec.gender && ![...form.elements.gender.options].some(o => o.value === rec.gender)) form.elements.gender.value = '';
  for (const c of ['consentWhatsapp','consentPhoto']) if (rec[c]) form.querySelector(`input[name=${c}][value=${rec[c]}]`)?.click();
  markMissing();
  show('step-form');
}
function markMissing() {
  for (const f of FIELDS) {
    const el = form.elements[f];
    const empty = !el.value.trim() && !onFile[f];
    el.classList.toggle('missing', empty);
    el.classList.remove('invalid');
  }
}
form.addEventListener('input', e => {
  if (e.target.name && FIELDS.includes(e.target.name)) {
    e.target.classList.toggle('missing', !e.target.value.trim() && !onFile[e.target.name]);
    e.target.classList.remove('invalid');
  }
});
$('back').addEventListener('click', () => show('step-search'));

form.addEventListener('submit', async e => {
  e.preventDefault();
  const data = { id: currentId };
  const problems = [];
  for (const f of FIELDS) {
    data[f] = form.elements[f].value.trim();
    if (!data[f] && !onFile[f]) { problems.push(f); form.elements[f].classList.add('invalid'); }
  }
  if (data.email && !/^\S+@\S+\.\S+$/.test(data.email)) { problems.push('email'); form.elements.email.classList.add('invalid'); }
  for (const c of ['consentWhatsapp','consentPhoto']) {
    data[c] = form.querySelector(`input[name=${c}]:checked`)?.value || '';
    if (!data[c]) problems.push(c);
  }
  if (problems.length) {
    $('err').textContent = 'Please complete all required fields (highlighted in red) and answer both consent questions.';
    $('err').style.display = 'block';
    form.querySelector('.invalid')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  $('submit').disabled = true; $('submit').textContent = 'Checking in…';
  try {
    const r = await fetch('/api/checkin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const out = await r.json();
    if (!r.ok) throw new Error(out.error || 'Something went wrong');
    try { localStorage.setItem('checkedIn', JSON.stringify(out)); } catch {}
    showSuccess(out);
  } catch (err) {
    $('err').textContent = err.message + ' Please try again or see the front desk.';
    $('err').style.display = 'block';
  } finally {
    $('submit').disabled = false; $('submit').textContent = 'Submit & Check in';
  }
});

function showSuccess(o) {
  $('s-name').textContent = o.firstName + ' ' + o.lastName;
  $('s-org').textContent = o.organisation || '';
  $('s-time').textContent = 'Checked in at ' + new Date(o.checkedInAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  show('success');
}
$('another').addEventListener('click', () => {
  try { localStorage.removeItem('checkedIn'); } catch {}
  $('q').value = ''; $('results').innerHTML = ''; $('noresults').classList.add('hidden');
  show('step-search');
});

// If this phone already checked in, keep showing the tick (handy at the front desk)
try { const saved = JSON.parse(localStorage.getItem('checkedIn')); if (saved) showSuccess(saved); } catch {}
