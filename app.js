// ===== Utilities =====
const el = id => document.getElementById(id);
const clamp = (v,min,max)=>Math.max(min,Math.min(max,v));
function qsParse(){ const o={}; const q=new URLSearchParams(location.search); q.forEach((v,k)=>o[k]=v); return o;}
function qsBuild(o){ const q=new URLSearchParams(); Object.entries(o).forEach(([k,v])=>q.set(k,String(v))); return q.toString();}
function nowStamp(){ const d=new Date(); const pad=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`; }

// ===== Core math =====
function bankNominalKWh(S,P,cellV,cellAh){ return (S*cellV*P*cellAh)/1000.0; } // kWh
function cRatePowerKw(cRate, Ah, V){ return (cRate * Ah * V)/1000.0; } // DC kW

function sizeSystemAvg(p){
  const hoursDaylight = (p.sunEnd - p.sunStart + 24) % 24;
  const nightHours = 24 - hoursDaylight;
  const pDay = p.acV * p.acADay / 1000.0;
  const pNight = p.acV * p.acANight / 1000.0;
  const dailyAc = pDay*hoursDaylight + pNight*nightHours;
  const dailyDc = dailyAc / p.invEff;
  const nightlyAc = pNight * nightHours;
  const nightlyDc = nightlyAc / p.invEff;

  const reqUsableBatt1 = nightlyDc / p.rtEff;
  const reqNomBatt1 = reqUsableBatt1 / p.dod;
  const reqNomBattN = reqNomBatt1 * p.nAut;

  const pvReqOff = dailyDc / (p.psh * p.derate); // no grid
  return {hoursDaylight, nightHours, pDay, pNight, dailyAc, dailyDc, nightlyAc, nightlyDc, reqNomBatt1, reqNomBattN, pvReqOff};
}

// Half-sine daylight PV profile; grid assist at night (covers load first, then charges).
function simulate(p){
  const dtMin = 15;
  const steps = Math.max(1, Math.round((p.simDays * 24 * 60) / dtMin));
  const hours = new Float64Array(steps);
  const soc = new Float64Array(steps);

  const hoursDay = (p.sunEnd - p.sunStart + 24) % 24;
  const areaPerDay = (2 * hoursDay / Math.PI); // integral sin(0..pi)
  const dtH = dtMin/60;

  // Bank params
  const bankV = p.batS * p.cellV;
  const bankAh = p.batP * p.cellAh;
  const bankNomKWh = bankNominalKWh(p.batS,p.batP,p.cellV,p.cellAh);
  const usable = Math.max(0.0001, bankNomKWh * p.dod);
  soc[0] = usable;

  // C-rate limits (DC kW)
  const chgMaxKw = cRatePowerKw(p.cCharge, bankAh, bankV);
  const dsgMaxKw = cRatePowerKw(p.cDischarge, bankAh, bankV);

  // Tracking
  let pvKWh=0, gridKWh=0, loadAcKWh=0, battDsgKWh=0, battChgKWh=0;
  let violChg=0, violDsg=0;

  for(let i=0;i<steps;i++){
    const tH = i*dtH;
    hours[i] = tH;
    const hod = (tH % 24 + 24) % 24;
    const isDay = (hod >= p.sunStart && hod < p.sunEnd);
    const inGrid = p.gridOn && (p.gridStart < p.gridEnd
      ? (hod >= p.gridStart && hod < p.gridEnd)
      : (hod >= p.gridStart || hod < p.gridEnd)); // overnight wrap

    // Load (AC kW)
    const acLoadKw = isDay ? (p.acV*p.acADay/1000) : (p.acV*p.acANight/1000);
    loadAcKWh += acLoadKw*dtH;

    // PV DC kW
    let shape = 0;
    if(isDay){
      const tn = (hod - p.sunStart) / hoursDay * Math.PI;
      shape = Math.sin(tn);
    }
    const scale = p.psh / areaPerDay;
    const pvKwDc = Math.max(0, p.arrayKw * p.derate * shape * scale);
    pvKWh += pvKwDc*dtH;

    // First, PV helps cover DC-equivalent load
    const dcLoadKw = acLoadKw / p.invEff;
    let net = pvKwDc - dcLoadKw;

    // GRID: cover load first, then charge up to power limit
    if(inGrid){
      const gridAcKw = Math.max(0, p.gridMaxKw);
      const gridForLoadDcKw = Math.min(Math.max(0,-net), gridAcKw / p.invEff);
      net += gridForLoadDcKw;
      const gridDcAvailKw = Math.max(0, gridAcKw / p.invEff - gridForLoadDcKw);
      gridKWh += (gridForLoadDcKw + gridDcAvailKw)*dtH;

      // Treat gridDcAvailKw as additional positive net (charging capability)
      net += gridDcAvailKw;
    }

    // Battery with round-trip & C-rate
    if(net >= 0){
      // charging
      let chgKw = net;
      chgKw = Math.min(chgKw, chgMaxKw);
      const room = usable - (i>0? soc[i-1]:usable);
      const maxByRoom = room / (p.rtEff*dtH);
      chgKw = Math.min(chgKw, maxByRoom);
      if(i>0) soc[i] = soc[i-1] + chgKw * p.rtEff * dtH;
      battChgKWh += chgKw*dtH;
      if(net > chgMaxKw + 1e-6) violChg++;
    }else{
      // discharging
      let dsgKw = -net;
      dsgKw = Math.min(dsgKw, dsgMaxKw);
      const maxBySOC = (soc[i-1]||usable) / p.rtEff / dtH;
      dsgKw = Math.min(dsgKw, maxBySOC);
      if(i>0) soc[i] = soc[i-1] - dsgKw * p.rtEff * dtH;
      battDsgKWh += dsgKw*dtH;
      if(-net > dsgMaxKw + 1e-6) violDsg++;
    }

    if(i===0) soc[0] = usable;
  }

  const socPct = Array.from(soc, v => usable>0 ? v / usable * 100 : 0);

  return {
    hours: Array.from(hours),
    socPct,
    summary: {
      pvKWh, gridKWh, loadAcKWh, battDsgKWh, battChgKWh,
      violChg, violDsg,
      chgMaxKw, dsgMaxKw,
      bankNomKWh: bankNominalKWh(p.batS,p.batP,p.cellV,p.cellAh),
      usableKWh: usable
    }
  };
}

// ===== Charts (Canvas) =====
function setupCanvas(canvas){
  const DPR = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
  canvas.width = Math.max(300, cssW * DPR);
  canvas.height = Math.max(200, cssH * DPR);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(DPR,0,0,DPR,0,0);
  return {ctx, width: cssW, height: cssH};
}
function drawBarChart(canvas, labels, values){
  const {ctx,width,height} = setupCanvas(canvas);
  const pad = Math.min(32, Math.max(20, width*0.06));
  const innerW = width - pad*2, innerH = height - pad*2;
  ctx.clearRect(0,0,width,height);
  ctx.strokeStyle = '#2b3247'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, height-pad); ctx.lineTo(width-pad, height-pad);
  ctx.moveTo(pad, pad); ctx.lineTo(pad, height-pad); ctx.stroke();

  const maxVal = Math.max(...values)*1.15 || 1;
  const bw = innerW / (values.length*1.6);
  for(let i=0;i<values.length;i++){
    const v = values[i];
    const h = innerH * (v/maxVal);
    const x = pad + i*(bw*1.6) + bw*0.3;
    const y = height - pad - h;
    const grad = ctx.createLinearGradient(0, y, 0, y+h);
    grad.addColorStop(0, '#34d6ff'); grad.addColorStop(1, '#2bdc8c');
    ctx.fillStyle = grad; ctx.fillRect(x, y, bw, h);
    ctx.fillStyle = '#cfe7ff'; ctx.font = '12px Inter, sans-serif'; ctx.textAlign='center';
    ctx.fillText(v.toFixed(1), x + bw/2, y - 6);
    ctx.fillStyle = '#9fb2d7'; wrapText(ctx, labels[i], x + bw/2, height - pad + 14, bw*1.7, 12);
  }
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight){
  const words = text.split(' '); let line=''; let yy=y; ctx.textAlign='center';
  for(let n=0;n<words.length;n++){
    const test=line+words[n]+' ';
    if(ctx.measureText(test).width>maxWidth && n>0){ ctx.fillText(line,x,yy); line=words[n]+' '; yy+=lineHeight; }
    else { line=test; }
  }
  ctx.fillText(line,x,yy);
}
function drawLineChart(canvas, xs, ys){
  const {ctx,width,height} = setupCanvas(canvas);
  const pad = Math.min(32, Math.max(20, width*0.06));
  const innerW = width - pad*2, innerH = height - pad*2;

  ctx.clearRect(0,0,width,height);
  ctx.strokeStyle = '#2b3247'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad, pad); ctx.lineTo(pad, height - pad); ctx.lineTo(width - pad, height - pad); ctx.stroke();

  ctx.font = '12px Inter, sans-serif'; ctx.fillStyle = '#9fb2d7';
  const yMax = Math.max(100, Math.ceil(Math.max(...ys)/10)*10);
  for(let g=0; g<=5; g++){
    const gy = pad + g*(innerH/5); const val = Math.round((1 - g/5)*yMax);
    ctx.strokeStyle = '#232a3e'; ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(width - pad, gy); ctx.stroke();
    ctx.fillText(val + '%', 6, gy+4);
  }
  const xMax = xs[xs.length-1] || 1; const ticks = Math.min(10, Math.ceil(xMax/6));
  for(let t=0;t<=ticks;t++){ const h = t*(xMax/ticks); const xx = pad + (h/xMax)*innerW; ctx.fillText(h.toFixed(0)+'h', xx-10, height - pad + 16); }

  ctx.lineWidth = 2.5; const grad = ctx.createLinearGradient(pad, pad, pad, height - pad);
  grad.addColorStop(0, '#34d6ff'); grad.addColorStop(1, '#2bdc8c'); ctx.strokeStyle = grad;
  ctx.beginPath();
  for(let i=0;i<xs.length;i++){
    const xx = pad + (xs[i]/xMax)*innerW; const yy = pad + (1 - ys[i]/yMax)*innerH;
    if(i===0) ctx.moveTo(xx, yy); else ctx.lineTo(xx, yy);
  } ctx.stroke();
}

// ===== State =====
const defaults = {
  acV:230, acADay:10, acANight:10, sunStart:6, sunEnd:17, psh:5.5, derate:0.75,
  invEff:0.92, rtEff:0.85, dod:0.5, nAut:3, simDays:3,
  batS:4, batP:4, cellV:12, cellAh:200,
  cCharge:0.2, cDischarge:0.5,
  pvMax:5.6, invKw:6.0, useExistingPv:true,
  gridOn:true, gridStart:17, gridEnd:6, gridMaxKw:3.0
};
const state = {...defaults};

// ===== UI Wiring =====
const fieldIds = [
  'acV','acADay','acANight','sunStart','sunEnd','psh','derate',
  'invEff','rtEff','dod','nAut','simDays',
  'batS','batP','cellV','cellAh',
  'cCharge','cDischarge','gridStart','gridEnd','gridMaxKw'
];
fieldIds.forEach(k=>{
  const e = el(k);
  e.addEventListener('input', ()=>{ const v=parseFloat(e.value); state[k]=isNaN(v)?defaults[k]:v; recalc(); });
});
el('gridOn').addEventListener('change', ()=>{ state.gridOn = el('gridOn').checked; recalc(); });
el('useExistingPv').addEventListener('change', ()=>{ state.useExistingPv = el('useExistingPv').checked; recalc(); });

el('btnReset').addEventListener('click', ()=>{
  Object.assign(state, defaults);
  [...fieldIds, 'useExistingPv'].forEach(k=>{ if(el(k)) el(k).value = defaults[k]; });
  el('gridOn').checked = defaults.gridOn;
  el('useExistingPv').checked = defaults.useExistingPv;
  history.replaceState(null,'',location.pathname);
  recalc();
});
el('btnAhmad').addEventListener('click', ()=>{
  Object.assign(state, defaults);
  [...fieldIds, 'useExistingPv'].forEach(k=>{ if(el(k)) el(k).value = defaults[k]; });
  el('gridOn').checked = defaults.gridOn;
  el('useExistingPv').checked = defaults.useExistingPv;
  recalc();
});

// Share preset link
el('btnShare').addEventListener('click', async ()=>{
  const q = {...state, useExistingPv: state.useExistingPv?1:0, gridOn: state.gridOn?1:0};
  const url = location.origin + location.pathname + '?' + qsBuild(q);
  try{
    await navigator.clipboard.writeText(url);
    const tag = el('shareTag'); tag.style.display='inline-flex'; tag.classList.add('copy-ok');
    setTimeout(()=>{ tag.style.display='none'; tag.classList.remove('copy-ok');}, 1200);
  }catch(e){
    prompt('Copy this URL:', url);
  }
});

// Export report
el('btnExport').addEventListener('click', exportReport);

// ===== Recalc & Render =====
function recalc(){
  const p = {...state};

  // Average sizing
  const S = sizeSystemAvg(p);

  // PV array used for sim
  const arrayKwNeededOff = S.dailyDc / (p.psh * p.derate);
  let arrayKw = arrayKwNeededOff;
  if(p.useExistingPv) arrayKw = Math.min(p.pvMax, Math.max(0.1, arrayKw));

  // Simulate
  const sim = simulate({...p, arrayKw});
  const M = sim.summary;

  // PV required with grid assist (reduce DC energy by average grid DC contribution/day)
  const dailyDcWithGrid = Math.max(0, S.dailyDc - (M.gridKWh / p.simDays));
  const pvReqWith = dailyDcWithGrid / (p.psh * p.derate);

  // Outputs
  el('kLoadDay').textContent   = S.pDay.toFixed(2);
  el('kLoadNight').textContent = S.pNight.toFixed(2);
  el('kDailyAC').textContent   = S.dailyAc.toFixed(1);
  el('kPVOff').innerHTML       = S.pvReqOff.toFixed(1) + (S.pvReqOff > p.pvMax && p.useExistingPv ? ' <span class="bad">(>&nbsp;PV cap)</span>' : '');
  el('kPVWith').textContent    = pvReqWith.toFixed(1);
  el('kBatt3').textContent     = S.reqNomBattN.toFixed(1);

  el('kPVExist').textContent   = p.pvMax.toFixed(1);
  el('kBattNom').textContent   = M.bankNomKWh.toFixed(1);
  el('kBattUse').textContent   = M.usableKWh.toFixed(1);

  // Sticky minis
  el('miniPV').textContent   = S.pvReqOff.toFixed(1);
  el('miniBATT').textContent = S.reqNomBattN.toFixed(0);
  el('miniLOAD').textContent = (S.pDay).toFixed(2);

  // Limits + violations
  el('chgMax').textContent = M.chgMaxKw.toFixed(2);
  el('dsgMax').textContent = M.dsgMaxKw.toFixed(2);
  const viol = (M.violChg>0 || M.violDsg>0);
  el('tagViol').style.display = viol ? 'inline-flex':'none';
  el('violTxt').textContent = viol
    ? `Violations — charge:${M.violChg} discharge:${M.violDsg}`
    : 'No violations';

  // Bank summary
  el('bankSummary').textContent =
    `Bank: ${p.batS}S × ${p.batP}P of ${p.cellV.toFixed(1)} V, ${p.cellAh.toFixed(0)} Ah → `
    + `${(p.batS*p.cellV).toFixed(1)} V × ${(p.batP*p.cellAh).toFixed(0)} Ah = ${M.bankNomKWh.toFixed(1)} kWh nominal, `
    + `${M.usableKWh.toFixed(1)} kWh usable @ DoD ${Math.round(p.dod*100)}%. `
    + `Charge limit ${M.chgMaxKw.toFixed(2)} kW, discharge limit ${M.dsgMaxKw.toFixed(2)} kW.`;

  // Charts
  const dayKWh = S.pDay * S.hoursDaylight;
  const nightKWh = S.pNight * S.nightHours;
  const pvPerDay = (M.pvKWh / p.simDays);
  const gridPerDay = (M.gridKWh / p.simDays);
  drawBarChart(el('barChart'), ['Day Load','Night Load','PV Gen/day','Grid Energy/day'], [dayKWh, nightKWh, pvPerDay, gridPerDay]);
  drawLineChart(el('socChart'), sim.hours, sim.socPct);
}

// ===== Export (HTML report with embedded images) =====
async function exportReport(){
  // Capture current charts as images
  const barDataUrl = el('barChart').toDataURL('image/png');
  const socDataUrl = el('socChart').toDataURL('image/png');

  // Snapshot inputs & outputs
  const cfg = {...state};
  const outputs = {
    dayLoadKw: el('kLoadDay').textContent,
    nightLoadKw: el('kLoadNight').textContent,
    dailyAcKWh: el('kDailyAC').textContent,
    pvOffKw: el('kPVOff').textContent.replace(/<[^>]*>/g,''),
    pvWithKw: el('kPVWith').textContent,
    batt3KWh: el('kBatt3').textContent,
    bankNomKWh: el('kBattNom').textContent,
    bankUseKWh: el('kBattUse').textContent,
    chgMaxKw: el('chgMax').textContent,
    dsgMaxKw: el('dsgMax').textContent,
    violations: (el('tagViol').style.display!=='none') ? el('violTxt').textContent : 'No violations'
  };

  const reportCSS = `
    body{font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;color:#111;margin:24px}
    h1{font-size:22px;margin:0 0 8px} h2{font-size:16px;margin:18px 0 8px}
    .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    .card{border:1px solid #ddd;border-radius:10px;padding:12px}
    table{width:100%;border-collapse:collapse;font-size:13px}
    th,td{border:1px solid #e5e5e5;padding:6px 8px;text-align:left}
    .muted{color:#666}
    img{max-width:100%;height:auto;border:1px solid #eee;border-radius:8px}
    @media print{.no-print{display:none}}
  `;

  const rows = (obj, keys) => keys.map(k=>`<tr><th>${k}</th><td>${obj[k]}</td></tr>`).join('');

  const html = `
<!DOCTYPE html><html><head><meta charset="utf-8"><title>Solar Report</title>
<style>${reportCSS}</style></head><body>
<h1>Solar Sizing Report</h1>
<div class="muted">Generated: ${new Date().toLocaleString()}</div>

<h2>Configuration</h2>
<div class="grid">
  <div class="card"><h3>Load & Sun</h3><table>
    ${rows(cfg, ['acV','acADay','acANight','sunStart','sunEnd','psh','derate'])}
  </table></div>
  <div class="card"><h3>Efficiency & Autonomy</h3><table>
    ${rows(cfg, ['invEff','rtEff','dod','nAut','simDays'])}
  </table></div>
  <div class="card"><h3>Battery</h3><table>
    ${rows(cfg, ['batS','batP','cellV','cellAh'])}
  </table></div>
  <div class="card"><h3>Limits & Grid</h3><table>
    ${rows(cfg, ['cCharge','cDischarge','pvMax','useExistingPv','gridOn','gridStart','gridEnd','gridMaxKw'])}
  </table></div>
</div>

<h2>Key Outputs</h2>
<div class="grid">
  <div class="card"><table>
    ${rows(outputs, ['dayLoadKw','nightLoadKw','dailyAcKWh','pvOffKw','pvWithKw','batt3KWh'])}
  </table></div>
  <div class="card"><table>
    ${rows(outputs, ['bankNomKWh','bankUseKWh','chgMaxKw','dsgMaxKw','violations'])}
  </table></div>
</div>

<h2>Charts</h2>
<div class="grid">
  <div class="card"><h3>Daily Energy Balance</h3><img src="${barDataUrl}" alt="Daily Energy Balance"></div>
  <div class="card"><h3>Battery SOC</h3><img src="${socDataUrl}" alt="Battery SOC"></div>
</div>

<div class="no-print" style="margin-top:16px">
  <button onclick="window.print()">Print / Save as PDF</button>
</div>
</body></html>`.trim();

  const blob = new Blob([html], {type:'text/html'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `solar_report_${nowStamp()}.html`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(a.href);
}

// ===== Init =====
function hydrateFromURL(){
  const q = qsParse();
  if(Object.keys(q).length===0) return;
  const num = (k, d)=> (k in q ? parseFloat(q[k]) : d);
  const bool = (k, d)=> (k in q ? (q[k]==='1'||q[k]==='true') : d);
  const patch = {
    acV:num('acV',defaults.acV), acADay:num('acADay',defaults.acADay), acANight:num('acANight',defaults.acANight),
    sunStart:num('sunStart',defaults.sunStart), sunEnd:num('sunEnd',defaults.sunEnd),
    psh:num('psh',defaults.psh), derate:num('derate',defaults.derate),
    invEff:num('invEff',defaults.invEff), rtEff:num('rtEff',defaults.rtEff),
    dod:num('dod',defaults.dod), nAut:num('nAut',defaults.nAut), simDays:num('simDays',defaults.simDays),
    batS:num('batS',defaults.batS), batP:num('batP',defaults.batP), cellV:num('cellV',defaults.cellV), cellAh:num('cellAh',defaults.cellAh),
    cCharge:num('cCharge',defaults.cCharge), cDischarge:num('cDischarge',defaults.cDischarge),
    pvMax:num('pvMax',defaults.pvMax), invKw:num('invKw',defaults.invKw),
    gridOn:bool('gridOn',defaults.gridOn), gridStart:num('gridStart',defaults.gridStart), gridEnd:num('gridEnd',defaults.gridEnd), gridMaxKw:num('gridMaxKw',defaults.gridMaxKw),
    useExistingPv:bool('useExistingPv',defaults.useExistingPv)
  };
  Object.assign(state, patch);
  // push values into inputs
  fieldIds.forEach(k=>{ if(el(k)) el(k).value = state[k]; });
  el('gridOn').checked = state.gridOn; el('useExistingPv').checked = state.useExistingPv;
}
window.addEventListener('resize', ()=>recalc());
window.addEventListener('orientationchange', ()=>recalc());

// Boot
hydrateFromURL();
recalc();
