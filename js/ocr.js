// ============================================================
// 稿紙格線辨識（國寫直式稿紙 38 欄 × 22 列）
// ------------------------------------------------------------
// 做法：在瀏覽器裡把稿紙照片拉正 → 切成每一格 → 本機偵測哪格有字 →
//       每幾欄拼成一張長條圖，連同「有字遮罩」交給後端用辨識模型逐格讀字。
// 好處：每格只看一個字，模型不會跨欄亂讀、不會自己補句子；金鑰留在後端，不會出現在瀏覽器。
// 本檔的切格／偵測演算法來自獨立的辨識工具，只把「呼叫模型」與「輸出」換成接進批改系統的版本。
//
// 用法：openGridOcr({ essayId, photos:[{ load: () => Promise<dataURL> }], api, onApply({text, mode, info}) })
// ============================================================
// ------------------------------------------------------------
// 彈性格線對齊：拉正後的圖假設格線是均勻的，但實際照片有彎曲、局部歪斜。
// 這裡在「垂直方向分帶」量每條直線的實際位置、「水平方向分帶」量每條橫線的實際位置，
// 再用二次曲線穩健擬合（剔除偵測錯誤的線），得到每個格線交點的真實位置（網格節點）。
// V、Hm：線條遮罩（1=疑似格線）；回傳 NX/NY：(COLS+1)×(ROWS+1) 個節點在拉正圖上的座標。
// ------------------------------------------------------------
export function elasticNodes(V, Hm, W, H, COLS, ROWS, CS, opt = {}) {
  const S = opt.search || Math.round(CS * 0.3), NBY = opt.bandsY || 6, NBX = opt.bandsX || 10;
  let valid = 0, total = 0, maxShift = 0;
  const sm = (a) => { const o = new Float32Array(a.length); for (let i = 0; i < a.length; i++) { let t = 0, c = 0; for (let k = -2; k <= 2; k++) { const j = i + k; if (j >= 0 && j < a.length) { t += a[j]; c++; } } o[i] = t / c; } return o; };
  // 偵測一組線（共 n+1 條，預期位置 i*CS）：在 ±S 範圍找剖面最高點
  const peaks = (P, n, len, span) => {
    const Q = sm(P), out = [];
    for (let i = 0; i <= n; i++) {
      const x0 = i * CS; let best = -1, bd = 0;
      for (let d = -S; d <= S; d++) { const x = x0 + d; if (x < 0 || x >= len) continue; if (Q[x] > best) { best = Q[x]; bd = d; } }
      let m = 0, c = 0; for (let x = Math.max(0, x0 - 30); x <= Math.min(len - 1, x0 + 30); x++) { m += Q[x]; c++; } m /= c || 1;
      total++; if (best > m * 1.4 && best > span * 0.2) { out.push(bd); valid++; } else out.push(null);
    }
    return out;
  };
  const fit2 = (pts) => { // 最小平方二次擬合 y = a + b t + c t²
    const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], b = [0, 0, 0];
    pts.forEach(([t, y]) => { const p = [1, t, t * t]; for (let r = 0; r < 3; r++) { b[r] += y * p[r]; for (let c = 0; c < 3; c++) A[r][c] += p[r] * p[c]; } });
    for (let i = 0; i < 3; i++) { let m = i; for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[m][i])) m = r;
      [A[i], A[m]] = [A[m], A[i]]; [b[i], b[m]] = [b[m], b[i]]; if (Math.abs(A[i][i]) < 1e-12) return [0, 0, 0];
      for (let r = i + 1; r < 3; r++) { const f = A[r][i] / A[i][i]; for (let c = i; c < 3; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; } }
    const x = [0, 0, 0]; for (let i = 2; i >= 0; i--) { let t = b[i]; for (let c = i + 1; c < 3; c++) t -= A[i][c] * x[c]; x[i] = t / A[i][i]; } return x;
  };
  const smooth = (d) => {
    const n = d.length, pts = []; d.forEach((v, i) => { if (v != null) pts.push([i / (n - 1), v]); });
    if (pts.length < 6) return d.map(() => 0);
    let use = pts, co = fit2(use);
    for (let it = 0; it < 3; it++) { co = fit2(use); const nu = pts.filter(([t, v]) => Math.abs(v - co[0] - co[1] * t - co[2] * t * t) <= 4); if (nu.length < 6) break; use = nu; }
    return d.map((v, i) => { const t = i / (n - 1), f = co[0] + co[1] * t + co[2] * t * t; return v != null && Math.abs(v - f) <= 4 ? v : f; });
  };
  const yb = Array.from({ length: NBY + 1 }, (_, b) => Math.round(b * ROWS / NBY) * CS);
  const xb = Array.from({ length: NBX + 1 }, (_, b) => Math.round(b * COLS / NBX) * CS);
  const dxB = [], dyB = [];
  for (let b = 0; b < NBY; b++) { const P = new Float32Array(W); for (let y = yb[b]; y < yb[b + 1]; y++) { const o = y * W; for (let x = 0; x < W; x++) P[x] += V[o + x]; } dxB.push(smooth(peaks(P, COLS, W, yb[b + 1] - yb[b]))); }
  for (let b = 0; b < NBX; b++) { const P = new Float32Array(H); for (let y = 0; y < H; y++) { const o = y * W; let t = 0; for (let x = xb[b]; x < xb[b + 1]; x++) t += Hm[o + x]; P[y] = t; } dyB.push(smooth(peaks(P, ROWS, H, xb[b + 1] - xb[b]))); }
  const yc = yb.slice(0, -1).map((v, b) => (v + yb[b + 1]) / 2), xc = xb.slice(0, -1).map((v, b) => (v + xb[b + 1]) / 2);
  const lerp = (arr, cen, i, pos) => { const nb = cen.length; if (pos <= cen[0]) return arr[0][i]; if (pos >= cen[nb - 1]) return arr[nb - 1][i];
    let b = 0; while (pos > cen[b + 1]) b++; const t = (pos - cen[b]) / (cen[b + 1] - cen[b]); return arr[b][i] * (1 - t) + arr[b + 1][i] * t; };
  const NX = new Float32Array((COLS + 1) * (ROWS + 1)), NY = new Float32Array((COLS + 1) * (ROWS + 1));
  for (let j = 0; j <= ROWS; j++) for (let i = 0; i <= COLS; i++) {
    const dx = lerp(dxB, yc, i, j * CS), dy = lerp(dyB, xc, j, i * CS), k = j * (COLS + 1) + i;
    NX[k] = i * CS + dx; NY[k] = j * CS + dy; maxShift = Math.max(maxShift, Math.abs(dx), Math.abs(dy));
  }
  return { NX, NY, maxShift, validRatio: total ? valid / total : 0 };
}

// 線條遮罩：稿紙是綠線就用顏色；不是的話改用「長條直線」偵測（手寫筆畫很少形成長直線）
function lineMasks(wd, W, H, bxf) {
  const n = W * H; let gc = 0; const G = new Uint8Array(n);
  for (let i = 0; i < n; i++) { const r = wd[i * 4], g = wd[i * 4 + 1], b = wd[i * 4 + 2]; if (g - (r + b) / 2 > 6 && g < 235) { G[i] = 1; gc++; } }
  if (gc > n * 0.003) return { V: G, Hm: G };
  const gray = new Float32Array(n); for (let i = 0; i < n; i++) gray[i] = .3 * wd[i * 4] + .59 * wd[i * 4 + 1] + .11 * wd[i * 4 + 2];
  const mu = bxf(gray, W, H, 14, 14), rr = new Float32Array(n); for (let i = 0; i < n; i++) rr[i] = gray[i] < mu[i] * .94 ? 1 : 0;
  const hm = bxf(rr, W, H, 10, 0), vm = bxf(rr, W, H, 0, 10), V = new Uint8Array(n), Hm = new Uint8Array(n);
  for (let i = 0; i < n; i++) { if (vm[i] > .8) V[i] = 1; if (hm[i] > .8) Hm[i] = 1; }
  return { V, Hm };
}

export function openGridOcr(opts) {
  const root = document.createElement('div');
  root.className = 'ogo';
  root.innerHTML = `<header class="ogo-bar">
  <button class="icon-btn" id="og-close" aria-label="關閉"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
  <div class="ogo-bar-title"><b>稿紙格線辨識</b><small>只裁切「作答格線區」送去辨識，不含姓名、學號表頭；每格只讀一個字，仍請對照照片檢查</small></div>
  <ol class="ogo-steps" aria-hidden="true"><li>選稿紙</li><li>點四角</li><li>切格</li><li>辨識</li><li>寫入</li></ol>
</header>
<div class="ogo-inner">
<section class="card ogo-card">
  <div class="ogo-head"><span class="ogo-no">1</span><div><h3>選稿紙</h3><p class="muted small">國寫一張稿紙就是一個大題（正面第一題、背面第二題），兩面請分兩次辨識。</p></div></div>
  <div class="ogo-row">
    <label class="ogo-f"><span>作文照片</span><select id="og-photo"></select></label>
    <button class="btn outline sm" id="og-load">載入這張</button>
    <label class="ogo-f"><span>這張稿紙是</span><select id="og-which"><option>第一大題</option><option>第二大題</option><option>稿紙</option></select></label>
  </div>
  <label class="ogo-file"><span class="btn outline sm">📁 改用原始檔</span><input type="file" id="og-file" accept="image/*"><small>手機／相機原始檔解析度更高，辨識較準</small></label>
</section>

<section class="card ogo-card">
  <div class="ogo-head"><span class="ogo-no">2</span><div><h3>點格線四角</h3><p class="muted small">依序點格線區（38×22 格，不含欄號列號）的外框四角：<b>左上 → 右上 → 右下 → 左下</b>，點完可拖曳微調。</p></div></div>
  <div class="ogo-row">
    <button class="btn primary sm" id="og-auto">✨ 智慧抓取四角</button>
    <button class="btn outline sm" id="og-rst">重設四角</button>
    <label class="ogo-f ogo-range"><span>滑鼠精細度</span><input type="range" id="og-sn" min="20" max="100" value="60"></label>
    <span class="ogo-msg" id="og-am"></span>
  </div>
  <div class="ogo-canvas-wrap"><canvas id="og-src" width="10" height="10"></canvas></div>
  <p class="muted small">精細度只在慢速微調時降速，快速移動維持 1:1；移出再移入會重新對齊。</p>
</section>

<section class="card ogo-card">
  <div class="ogo-head"><span class="ogo-no">3</span><div><h3>切格與有字偵測</h3><p class="muted small">藍框＝偵測有字；灰色＝尾端空白欄（不會送出）；點格子可手動切換；外圈紅字為欄號／列號，欄 1 在最右。</p></div><span class="chip ogo-count" id="og-cnt"></span></div>
  <div class="ogo-row">
    <label class="ogo-f ogo-range"><span>墨色相對暗度 %</span><input type="range" id="og-t" min="40" max="90" value="75"></label>
    <label class="ogo-f ogo-range"><span>最少墨點數</span><input type="range" id="og-r" min="3" max="120" value="20"></label>
    <label class="ogo-check"><input type="checkbox" id="og-al" checked> 彈性對齊格線<small>依稿紙實際線條微調，修正歪斜與彎曲</small></label>
  </div>
  <div class="ogo-canvas-wrap"><canvas id="og-ov"></canvas></div>
</section>

<section class="card ogo-card">
  <div class="ogo-head"><span class="ogo-no">4</span><div><h3>辨識與校正</h3><p class="muted small">滑過任一格會在右下角顯示放大圖；雙擊「、／，」可互換。</p></div><button class="btn primary" id="og-go">開始辨識</button></div>
  <div class="ogo-legend"><span class="ogo-lg amb">橘色＝、或，易混淆</span><span class="ogo-lg bad">紅色＝與偵測不一致或看不清，請人工確認</span><span class="ogo-st" id="og-st"></span></div>
  <div id="og-gw"><table id="og-grid"></table></div>
</section>

<section class="card ogo-card">
  <div class="ogo-head"><span class="ogo-no">5</span><div><h3>寫入作文</h3><p class="muted small">看不清楚的字會標成［？］。寫入後回到作文頁，請再對照照片檢查一次再批改。</p></div></div>
  <div class="ogo-modes">
    <label class="plan-opt"><input type="radio" name="og-mode" value="replace" checked><span>取代目前的作文文字</span></label>
    <label class="plan-opt"><input type="radio" name="og-mode" value="append"><span>接在目前文字後面<small>第二張稿紙用</small></span></label>
  </div>
  <label class="ogo-check"><input type="checkbox" id="og-pp" checked> 保留段落換行與開頭縮排（全形空格）</label>
  <textarea id="og-out"></textarea>
</section>
<div class="ogo-actions"><button class="btn outline" id="og-cancel">取消</button><button class="btn primary lg" id="og-apply">✅ 寫入作文文字</button></div>
<canvas id="og-cv" width="200" height="200"></canvas><canvas id="og-lp" width="160" height="160"></canvas>
</div>`;
  document.body.appendChild(root);
  document.body.classList.add('ogo-open');
  const sel = root.querySelector('#og-photo');
  sel.innerHTML = (opts.photos || []).map((p, i) => `<option value="${i}">作文照片 ${i + 1}</option>`).join('') || '<option value="-1">（沒有作文照片，請改選原始檔）</option>';
  function close() { try { gOff(); } catch {} root.remove(); document.body.classList.remove('ogo-open'); }

  // ===== 以下是辨識工具的主程式 =====
  const cssv=n=>getComputedStyle(root).getPropertyValue(n).trim(),ACC=()=>cssv('--p3')||'#91A3FB',DNG=()=>cssv('--danger')||'#E5484D';
  const $=s=>root.querySelector(s),COLS=38,ROWS=22,CS=60,W=COLS*CS,H=ROWS*CS;
  let inkN=[],vp=null,img,pts=[],drag=-1,k=1,warp,wd,warp0,wd0,alignInfo='',ghost={},ink=[],grid=[],bad=new Set();

  function setImg(b){img=b;const c=$('#og-src');c.width=Math.min(1100,img.width);c.height=img.height*c.width/img.width;k=img.width/c.width;pts=[];mdl=null;ink=[];grid=[];bad=new Set();ghost={};warp=warp0=null;alignInfo='';drawSrc();$('#og-cnt').textContent='';$('#og-grid').innerHTML=''}
  $('#og-file').onchange=async e=>{const f=e.target.files[0];if(!f)return;try{setImg(await createImageBitmap(f))}catch(err){alert('無法讀取這張圖片：'+err.message)}};
  async function loadPhoto(){const i=+$('#og-photo').value;if(!(opts.photos||[])[i])return;$('#og-am').textContent=' 載入照片中…';
   try{const src=await opts.photos[i].load(),blob=await (await fetch(src)).blob();setImg(await createImageBitmap(blob));$('#og-am').textContent=''}
   catch(err){$('#og-am').textContent=' 載入失敗：'+err.message}}
  $('#og-load').onclick=loadPhoto;
  // ---- 智慧抓四角（本機）----
  function bxf(a,w,h,rx,ry){const W1=w+1,I=new Float64Array(W1*(h+1));
   for(let y=0;y<h;y++){let t=0;for(let x=0;x<w;x++){t+=a[y*w+x];I[(y+1)*W1+x+1]=I[y*W1+x+1]+t}}
   const o=new Float32Array(w*h);for(let y=0;y<h;y++){const y0=Math.max(0,y-ry),y1=Math.min(h,y+ry+1);
    for(let x=0;x<w;x++){const x0=Math.max(0,x-rx),x1=Math.min(w,x+rx+1);o[y*w+x]=(I[y1*W1+x1]-I[y0*W1+x1]-I[y1*W1+x0]+I[y0*W1+x0])/((x1-x0)*(y1-y0))}}return o}
  function prof(X,Y,t,hz){const co=Math.cos(t),si=Math.sin(t),m=X.length,c=new Int32Array(m);let mn=1e9,mx=-1e9;
   for(let i=0;i<m;i++){const v=Math.round(hz?Y[i]*co-X[i]*si:X[i]*co+Y[i]*si);c[i]=v;if(v<mn)mn=v;if(v>mx)mx=v}
   const P=new Float32Array(mx-mn+1);for(let i=0;i<m;i++)P[c[i]-mn]++;return[P,mn]}
  function combFit(P0,n,lo,hi){const nz=Array.from(P0).filter(v=>v>0).sort((a,b)=>a-b),cap=nz[Math.floor(nz.length*.97)]||1,L=P0.length,P=new Float32Array(L);
   for(let i=0;i<L;i++)P[i]=Math.min(P0[i],cap);const Q=new Float32Array(L);for(let i=0;i<L;i++)Q[i]=(P[Math.max(0,i-1)]+P[i]+P[Math.min(L-1,i+1)])/3;
   let best=-1,bo=0,bp=lo;for(let p=lo;p<hi;p+=.25){const mo=Math.floor(L-1-(n-1)*p);for(let o=0;o<mo;o++){let t=0;for(let k=0;k<n;k++)t+=Q[Math.round(o+k*p)];if(t>best){best=t;bo=o;bp=p}}}
   return[bo,bp]}
  function lineFit(X,Y,hz,n,span){let bt=0,bs=-1;for(let d=-5;d<=5.01;d+=.25){const[P]=prof(X,Y,d*Math.PI/180,hz);let s=0;for(let i=0;i<P.length;i++)s+=P[i]*P[i];if(s>bs){bs=s;bt=d}}
   const[P,mn]=prof(X,Y,bt*Math.PI/180,hz),[o,p]=combFit(P,n,.4*span/(n-1),.97*span/(n-1));return{t:bt*Math.PI/180,o:mn+o,p}}
  function analyzeGray(g,dw,dh){const n=dw*dh,xc=dw/2,yc=dh/2,mu=bxf(g,dw,dh,7,7),r=new Float32Array(n);
   for(let i=0;i<n;i++)r[i]=g[i]<mu[i]*.96?1:0;const hm=bxf(r,dw,dh,7,0),vm=bxf(r,dw,dh,0,7),H=[[],[]],V=[[],[]],U=[[],[]];
   for(let i=0;i<n;i++){const x=i%dw-xc,y=((i/dw)|0)-yc,h=hm[i]>.75,v=vm[i]>.75;if(h){H[0].push(x);H[1].push(y)}if(v){V[0].push(x);V[1].push(y)}if(h||v){U[0].push(x);U[1].push(y)}}
   const A=lineFit(H[0],H[1],true,23,dh),B=lineFit(V[0],V[1],false,39,dw),ca=Math.cos(A.t),sa=Math.sin(A.t),cb=Math.cos(B.t),sb=Math.sin(B.t),m=U[0].length,hy=new Float32Array(m),vx=new Float32Array(m);
   for(let i=0;i<m;i++){hy[i]=U[1][i]*ca-U[0][i]*sa;vx[i]=U[0][i]*cb+U[1][i]*sb}
   let best=-9,bi=0,bj=0;for(let i=-3;i<=3;i++)for(let j=-3;j<=3;j++){const h0=A.o+i*A.p,h1=h0+22*A.p,v0=B.o+j*B.p,v1=v0+38*B.p;let a1=0,a2=0;
    for(let k=0;k<m;k++){const y=hy[k],x=vx[k];if(y>=h0-A.p&&y<=h1+A.p&&x>=v0-B.p&&x<=v1+B.p){a2++;if(y>=h0&&y<=h1&&x>=v0&&x<=v1)a1++}}
    const ar=(h1-h0)*(v1-v0),ea=(h1-h0+2*A.p)*(v1-v0+2*B.p),sc=a1/ar-(a2-a1)/(ea-ar);if(sc>best){best=sc;bi=i;bj=j}}
   return{img,xc,yc,dw,ca,sa,cb,sb,oh:A.o,ph:A.p,ov:B.o,pv:B.p,i:bi,j:bj}}
  function analyze(){const dw=Math.min(1400,img.width),dh=Math.round(img.height*dw/img.width),c=document.createElement('canvas');c.width=dw;c.height=dh;
   const x=c.getContext('2d');x.drawImage(img,0,0,dw,dh);const d=x.getImageData(0,0,dw,dh).data,g=new Float32Array(dw*dh);
   for(let i=0;i<g.length;i++)g[i]=.3*d[i*4]+.59*d[i*4+1]+.11*d[i*4+2];return analyzeGray(g,dw,dh)}
  let mdl=null;
  $('#og-auto').onclick=()=>{if(!img)return alert('請先載入照片');$('#og-am').textContent=' 分析中…';
   setTimeout(()=>{try{const m=mdl&&mdl.img===img?mdl:(mdl=analyze()),sc=m.dw/img.width*k;let h0,v0;
    if(pts.length==1){const X=pts[0][0]*sc-m.xc,Y=pts[0][1]*sc-m.yc,hy=Y*m.ca-X*m.sa,vx=X*m.cb+Y*m.sb;
     h0=m.oh+Math.round((hy-m.oh)/m.ph)*m.ph;v0=m.ov+Math.round((vx-m.ov)/m.pv)*m.pv}
    else{h0=m.oh+m.i*m.ph;v0=m.ov+m.j*m.pv}
    const h1=h0+22*m.ph,v1=v0+38*m.pv,det=-m.sa*m.sb-m.ca*m.cb;
    pts=[[h0,v0],[h0,v1],[h1,v1],[h1,v0]].map(([h,v])=>[((h*m.sb-m.ca*v)/det+m.xc)/sc,((-m.sa*v-m.cb*h)/det+m.yc)/sc]);
    const S=$('#og-src');let cl=false;pts=pts.map(p=>{const q=[Math.min(S.width-3,Math.max(3,p[0])),Math.min(S.height-3,Math.max(3,p[1]))];if(q[0]!=p[0]||q[1]!=p[1])cl=true;return q});
    drawSrc();build();$('#og-am').textContent=(cl?' 有角點超出照片範圍，已拉回邊緣，請拖曳調整；':'')+' 已抓取；若整體偏移，請「重設」後只點左上角一點再按此鈕，會自動補齊另外三角'}
    catch(e){$('#og-am').textContent=' 失敗：'+e.message}},30)};
  $('#og-rst').onclick=()=>{pts=[];img&&drawSrc()};
  function drawSrc(){const c=$('#og-src'),x=c.getContext('2d');x.drawImage(img,0,0,c.width,c.height);
   x.strokeStyle=DNG();x.fillStyle=DNG();x.lineWidth=3;x.font='bold 18px sans-serif';
   if(pts.length>1){x.beginPath();pts.forEach((p,i)=>i?x.lineTo(...p):x.moveTo(...p));if(pts.length==4)x.closePath();x.stroke()}
   pts.forEach((p,i)=>{x.beginPath();x.arc(p[0],p[1],8,0,7);x.fill();x.fillText('左上,右上,右下,左下'.split(',')[i],p[0]+8,p[1]-8)});
   if(vp){x.strokeStyle=DNG();x.lineWidth=1;x.beginPath();x.moveTo(vp[0]-12,vp[1]);x.lineTo(vp[0]+12,vp[1]);x.moveTo(vp[0],vp[1]-12);x.lineTo(vp[0],vp[1]+12);x.stroke()}}
  const pos=(e,c)=>[e.offsetX*c.width/c.clientWidth,e.offsetY*c.height/c.clientHeight];
  const SRC=$('#og-src'),lp=$('#og-lp'),lx=lp.getContext('2d');
  const cpos=e=>{const r=SRC.getBoundingClientRect();return[(e.clientX-r.left)*SRC.width/r.width,(e.clientY-r.top)*SRC.height/r.height]};
  const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
  function down(e){if(!img)return;const p=[...(vp||cpos(e))];
   drag=pts.findIndex(q=>Math.hypot(q[0]-p[0],q[1]-p[1])<16);
   if(drag<0&&pts.length<4){pts.push(p);drag=pts.length-1}drawSrc();SRC.setPointerCapture(e.pointerId)}
  SRC.onpointerdown=down;
  function loupe(p){if(!img)return;const Z=40*k;lx.fillStyle='#fff';lx.fillRect(0,0,160,160);
   lx.drawImage(img,p[0]*k-Z/2,p[1]*k-Z/2,Z,Z,0,0,160,160);lx.strokeStyle=DNG();lx.lineWidth=1.5;lx.beginPath();
   lx.moveTo(80,0);lx.lineTo(80,160);lx.moveTo(0,80);lx.lineTo(160,80);lx.stroke();
   const r=SRC.getBoundingClientRect(),cx=r.left+p[0]*r.width/SRC.width,cy=r.top+p[1]*r.height/SRC.height;
   let L=cx+24,T=cy-184;if(T<0)T=cy+24;if(L+164>innerWidth)L=cx-188;
   lp.style.display='block';lp.style.left=L+'px';lp.style.top=T+'px'}
  // ---- 虛擬游標（慢速微調）----
  // 減速後，虛擬游標比真實滑鼠慢，真實滑鼠會先離開圖片。所以「進入圖片」後改在整份文件上追蹤滑鼠，
  // 只有「虛擬游標自己走出圖片範圍」才算離開；真實滑鼠在圖外時，點擊也會轉給圖片處理。
  let gOn=false;const GAP=48; // 虛擬游標與真實滑鼠的最大落差（螢幕像素）；調小＝更跟手，調大＝慢速範圍更長
  const gMove=e=>{if(e.pointerType=='mouse'&&e.target!==SRC)move(e)};
  const gDown=e=>{if(vp&&e.pointerType=='mouse'&&e.target!==SRC){e.preventDefault();e.stopPropagation();down(e)}};
  const gOff=()=>{if(!gOn)return;gOn=false;root.classList.remove('og-virt');document.removeEventListener('pointermove',gMove);document.removeEventListener('pointerdown',gDown,true);document.documentElement.removeEventListener('mouseleave',virtOff)};
  function virtOn(e){vp=cpos(e);if(gOn)return;gOn=true;root.classList.add('og-virt');document.addEventListener('pointermove',gMove);document.addEventListener('pointerdown',gDown,true);document.documentElement.addEventListener('mouseleave',virtOff)}
  function virtOff(){vp=null;lp.style.display='none';gOff();if(img)drawSrc()}
  function move(e){if(!img)return;
   if(e.pointerType=='mouse'){if(!vp)virtOn(e);
    const s0=$('#og-sn').value/100,sp=Math.hypot(e.movementX,e.movementY),S=sp>=10?1:s0+(1-s0)*sp/10,f=SRC.width/SRC.clientWidth,
     rp=cpos(e),G=GAP*f;let x=vp[0]+e.movementX*S*f,y=vp[1]+e.movementY*S*f;
    // 落差上限：虛擬游標最多落後真實滑鼠 GAP 個螢幕像素，超過就被拉回，避免落差越累積越大
    const dx=x-rp[0],dy=y-rp[1],d=Math.hypot(dx,dy);if(d>G){x=rp[0]+dx*G/d;y=rp[1]+dy*G/d}
    if(drag<0&&(x<0||y<0||x>SRC.width||y>SRC.height))return virtOff();  // 虛擬游標走出圖片才算離開
    vp=[clamp(x,0,SRC.width),clamp(y,0,SRC.height)]}
   const p=vp||cpos(e);
   if(drag>=0)pts[drag]=[clamp(p[0],3,SRC.width-3),clamp(p[1],3,SRC.height-3)];
   drawSrc();loupe(p)}
  SRC.onpointerenter=e=>{if(e.pointerType=='mouse')virtOn(e)};
  SRC.onpointermove=move;
  SRC.onpointerleave=e=>{if(e.pointerType!='mouse')virtOff()};
  $('#og-src').onpointerup=e=>{if(drag>=0&&pts.length==4)build();drag=-1;if(e.pointerType=='touch')lp.style.display='none'};

  function solve(A,b){const n=b.length;for(let i=0;i<n;i++){let m=i;for(let r=i+1;r<n;r++)if(Math.abs(A[r][i])>Math.abs(A[m][i]))m=r;
   [A[i],A[m]]=[A[m],A[i]];[b[i],b[m]]=[b[m],b[i]];
   for(let r=i+1;r<n;r++){const f=A[r][i]/A[i][i];for(let c=i;c<n;c++)A[r][c]-=f*A[i][c];b[r]-=f*b[i]}}
   const x=[];for(let i=n-1;i>=0;i--){let s=b[i];for(let c=i+1;c<n;c++)s-=A[i][c]*x[c];x[i]=s/A[i][i]}return x}
  function build(){const D=[[0,0],[W,0],[W,H],[0,H]],A=[],b=[];
   D.forEach(([x,y],i)=>{const[u,v]=[pts[i][0]*k,pts[i][1]*k];
    A.push([x,y,1,0,0,0,-u*x,-u*y]);b.push(u);A.push([0,0,0,x,y,1,-v*x,-v*y]);b.push(v)});
   const h=solve(A,b),s=document.createElement('canvas');s.width=img.width;s.height=img.height;
   const sx=s.getContext('2d');sx.drawImage(img,0,0);const S=sx.getImageData(0,0,s.width,s.height),sd=S.data,sw=s.width,sh=s.height;
   warp=document.createElement('canvas');warp.width=W;warp.height=H;const wc=warp.getContext('2d'),O=wc.createImageData(W,H);wd=O.data;
   for(let y=0;y<H;y++)for(let x=0;x<W;x++){const d=h[6]*x+h[7]*y+1,u=(h[0]*x+h[1]*y+h[2])/d,v=(h[3]*x+h[4]*y+h[5])/d,
    x0=Math.floor(u),y0=Math.floor(v),o=(y*W+x)*4;
    if(x0<0||y0<0||x0>=sw-1||y0>=sh-1){wd[o]=wd[o+1]=wd[o+2]=255;wd[o+3]=255;continue}
    const fx=u-x0,fy=v-y0;for(let c=0;c<3;c++){const i=(y0*sw+x0)*4+c;
     wd[o+c]=(sd[i]*(1-fx)+sd[i+4]*fx)*(1-fy)+(sd[i+sw*4]*(1-fx)+sd[i+sw*4+4]*fx)*fy}wd[o+3]=255}
   wc.putImageData(O,0,0);warp0=warp;wd0=wd;rectify();detect()}
  // 依實際格線把拉正圖「重新取樣」成均勻格子：之後的偵測、放大圖、送辨識的長條圖全部用這張
  function rectify(){alignInfo='';
   if(!$('#og-al').checked){warp=warp0;wd=wd0;return}
   try{const{V,Hm}=lineMasks(wd0,W,H,bxf),r=elasticNodes(V,Hm,W,H,COLS,ROWS,CS);
    if(r.validRatio<.35){warp=warp0;wd=wd0;alignInfo='格線偵測不足，沿用直線切格';return}
    const{NX,NY}=r,N1=COLS+1,out=new Uint8ClampedArray(W*H*4),sw=W,sh=H;
    for(let j=0;j<ROWS;j++)for(let i=0;i<COLS;i++){
     const a=j*N1+i,b=a+1,c=a+N1,d=c+1;
     for(let py=0;py<CS;py++){const v=(py+.5)/CS;
      for(let px=0;px<CS;px++){const u=(px+.5)/CS,w00=(1-u)*(1-v),w10=u*(1-v),w01=(1-u)*v,w11=u*v,
        sx=w00*NX[a]+w10*NX[b]+w01*NX[c]+w11*NX[d],sy=w00*NY[a]+w10*NY[b]+w01*NY[c]+w11*NY[d],
        o=((j*CS+py)*W+i*CS+px)*4,x0=Math.floor(sx),y0=Math.floor(sy);
       if(x0<0||y0<0||x0>=sw-1||y0>=sh-1){out[o]=out[o+1]=out[o+2]=255;out[o+3]=255;continue}
       const fx=sx-x0,fy=sy-y0,q=(y0*sw+x0)*4;
       for(let k=0;k<3;k++)out[o+k]=(wd0[q+k]*(1-fx)+wd0[q+4+k]*fx)*(1-fy)+(wd0[q+sw*4+k]*(1-fx)+wd0[q+sw*4+4+k]*fx)*fy;
       out[o+3]=255}}}
    warp=document.createElement('canvas');warp.width=W;warp.height=H;const id=new ImageData(out,W,H);warp.getContext('2d').putImageData(id,0,0);wd=out;
    alignInfo=`格線已彈性對齊（最大微調 ${r.maxShift.toFixed(0)}px）`}
   catch(e){console.warn(e);warp=warp0;wd=wd0;alignInfo='格線對齊失敗，沿用直線切格'}}
  let xs=[],ys=[];const M=50;
  function lines(){xs=Array.from({length:COLS+1},(_,i)=>i*CS);ys=Array.from({length:ROWS+1},(_,i)=>i*CS)}
  function detect(){if(!wd)return;lines();const T=$('#og-t').value/100,N=+$('#og-r').value,m=7,gray=new Float32Array(W*H);ink=[];
   for(let i=0;i<W*H;i++)gray[i]=.3*wd[i*4]+.59*wd[i*4+1]+.11*wd[i*4+2];
   for(let c=1;c<=COLS;c++){ink[c]=[];inkN[c]=[];const x0=xs[COLS-c]+m,x1=xs[COLS-c+1]-m;
    for(let r=0;r<ROWS;r++){const y0=ys[r]+m,y1=ys[r+1]-m,hist=new Uint16Array(256);
     for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++)hist[gray[y*W+x]|0]++;
     const tot=(x1-x0)*(y1-y0);let acc=0,bg=255;for(let v=0;v<256;v++){acc+=hist[v];if(acc>=tot*.85){bg=v;break}}
     let n=0;for(let y=y0;y<y1;y++)for(let x=x0;x<x1;x++){const i=y*W+x;
      if(gray[i]<bg*T){const j=i*4,a=wd[j],g=wd[j+1],b=wd[j+2];if(Math.max(a,g,b)-Math.min(a,g,b)<70&&!(g-(a+b)/2>6))n++}}
     ink[c][r]=n>=N;inkN[c][r]=n}}draw()}
  $('#og-t').oninput=$('#og-r').oninput=detect;$('#og-al').onchange=()=>{if(pts.length==4)build()};
  const last=()=>{let l=0;for(let c=1;c<=COLS;c++)if(ink[c]&&ink[c].some(Boolean))l=c;return l};
  function draw(){const o=$('#og-ov');o.width=W+2*M;o.height=H+2*M;const x=o.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,o.width,o.height);x.drawImage(warp,M,M);
   x.save();x.globalAlpha=.4;x.strokeStyle=DNG();x.lineWidth=1;x.beginPath();xs.forEach(v=>{x.moveTo(M+v,M);x.lineTo(M+v,M+H)});ys.forEach(v=>{x.moveTo(M,M+v);x.lineTo(M+W,M+v)});x.stroke();x.restore();
   const l=last();let n=0;x.fillStyle='rgba(128,128,128,.5)';x.fillRect(M,M,xs[COLS-l],H);x.strokeStyle=ACC();x.lineWidth=4;
   for(let c=1;c<=COLS;c++)for(let r=0;r<ROWS;r++)if(ink[c][r]){n++;x.strokeRect(M+xs[COLS-c]+4,M+ys[r]+4,xs[COLS-c+1]-xs[COLS-c]-8,ys[r+1]-ys[r]-8)}
   x.fillStyle=DNG();x.font='bold 28px sans-serif';x.textAlign='center';x.textBaseline='middle';
   for(let c=1;c<=COLS;c++){const cx=M+(xs[COLS-c]+xs[COLS-c+1])/2;x.fillText(c,cx,M/2);x.fillText(c,cx,M+H+M/2)}
   for(let r=0;r<ROWS;r++){const cy=M+(ys[r]+ys[r+1])/2;x.fillText(r+1,M/2,cy);x.fillText(r+1,M+W+M/2,cy)}
   $('#og-cnt').textContent=`使用 ${l} 欄，偵測 ${n} 個有字格`+(alignInfo?`｜${alignInfo}`:'')}
  $('#og-ov').onclick=e=>{if(!ink.length)return;const[px,py]=pos(e,e.target),X=px-M,Y=py-M,
   p=xs.findIndex((v,i)=>i<COLS&&X>=v&&X<xs[i+1]),r=ys.findIndex((v,i)=>i<ROWS&&Y>=v&&Y<ys[i+1]);
   if(p<0||r<0)return;const c=COLS-p;ink[c][r]=!ink[c][r];draw()};

  // ---- 拼圖 ----
  function strip(cols,cell){const gap=36,pad=20,top=40,c=document.createElement('canvas');
   c.width=pad*2+cols.length*cell+(cols.length-1)*gap;c.height=top+ROWS*cell+pad;const x=c.getContext('2d');
   x.fillStyle='#fff';x.fillRect(0,0,c.width,c.height);x.font='bold 24px sans-serif';x.textAlign='center';
   cols.forEach((n,i)=>{const px=pad+i*(cell+gap),p=COLS-n;
    for(let r=0;r<ROWS;r++)x.drawImage(warp,xs[p],ys[r],xs[p+1]-xs[p],ys[r+1]-ys[r],px,top+r*cell,cell,cell);
    x.fillStyle='#000';x.fillText('C'+String(n).padStart(2,'0'),px+cell/2,28)});
   return c.toDataURL('image/jpeg',.88).split(',')[1]}
  let firstCall=true;
  async function recog1(cols,cell,per){const imgs=[];for(let i=0;i<cols.length;i+=per)imgs.push(strip(cols.slice(i,i+per),cell));
   const mask={};cols.forEach(c=>{mask[c]=ink[c].map((v,r)=>v?(inkN[c][r]<150?2:1):0).join('')});
   const r=await opts.api.ocrGrid(opts.essayId,{images:imgs,cols,mask,rows:ROWS,first:firstCall});firstCall=false;return r.cols}
  async function recog(cols,cell,per,mx=3){const R=Math.min(mx,Math.max(1,Math.ceil(cols.length/14))),step=Math.ceil(cols.length/R),res=[];
   for(let k=0;k<cols.length;k+=step){$('#og-st').textContent=`辨識中 ${Math.min(k+step,cols.length)}/${cols.length} 欄…`;
    res.push(...await recog1(cols.slice(k,k+step),cell,per))}return res}
  const miss=(c,cells)=>{let n=0;for(let r=0;r<ROWS;r++)if(!!ink[c][r]!==!!(cells[r]||'')||(cells[r]||'').length>1)n++;return n+(cells.length!==ROWS?99:0)};

  $('#og-go').onclick=async()=>{if(!ink.length)return alert('請先完成四角點選');
   const used=[];for(let c=1;c<=last();c++)if(ink[c].some(Boolean))used.push(c);
   grid=[];bad=new Set();ghost={};firstCall=true;const st=$('#og-st'),fix={};
   try{st.textContent=`送出 ${used.length} 欄…`;
    (await recog(used,100,5)).forEach(o=>fix[o.c]=o.cells);
    const retry=used.filter(c=>!fix[c]||miss(c,fix[c])>0);
    if(retry.length){st.textContent=`補救重辨 ${retry.length} 欄…`;
     try{(await recog(retry,140,2,1)).forEach(o=>{if(!fix[o.c]||miss(o.c,o.cells)<miss(o.c,fix[o.c]))fix[o.c]=o.cells})}catch(e){console.warn(e)}}
    for(let c=1;c<=last();c++){const g=Array.from({length:ROWS},(_,r)=>(fix[c]||[])[r]||'');
     if(ink[c])g.forEach((v,r)=>{const key=c+','+r;
      if(!ink[c][r]){if(v){ghost[key]=v;g[r]='';bad.add(key)}return}   // 偵測是空白，模型卻給了字：不寫入，只留淡色提示
      if(!v){bad.add(key);g[r]='?'}else if(v==='?'||v.length>1)bad.add(key)});grid[c]=g}
    st.textContent=`完成，${bad.size} 格待確認`;render()}catch(e){st.textContent='錯誤：'+e.message}};

  function render(){const l=last(),t=$('#og-grid');let h='<tr><th></th>';
   for(let c=l;c>=1;c--)h+=`<th>${c}</th>`;h+='</tr>';
   for(let r=0;r<ROWS;r++){h+=`<tr><th>${r+1}</th>`;for(let c=l;c>=1;c--){const v=(grid[c]||[])[r]||'';
    h+=`<td><input data-c="${c}" data-r="${r}" value="${v.replace(/"/g,'&quot;')}" placeholder="${(ghost[c+','+r]||'').replace(/"/g,'&quot;')}" title="${ghost[c+','+r]?'偵測為空白格；模型曾讀成「'+ghost[c+','+r]+'」，沒有寫入':''}" class="${bad.has(c+','+r)?'bad':''}${!ink[c][r]&&!v?' blank':''}${v==='、'||v==='，'?' amb':''}"></td>`}h+='</tr>'}
   t.innerHTML=h;t.oninput=e=>{const i=e.target;grid[i.dataset.c][i.dataset.r]=i.value;i.classList.remove('bad');out()};
   t.ondblclick=e=>{const i=e.target,m={'、':'，','，':'、'};if(i.tagName=='INPUT'&&m[i.value]){i.value=m[i.value];grid[i.dataset.c][i.dataset.r]=i.value;i.classList.add('amb');out()}};
   t.onmouseover=t.onfocusin=showCell;t.onmouseleave=()=>$('#og-cv').style.display='none';out()}
  function showCell(e){const i=e.target;if(i.tagName!='INPUT'||!warp)return;const p=COLS-i.dataset.c,r=+i.dataset.r,x0=xs[p],y0=ys[r],w=xs[p+1]-x0,h=ys[r+1]-y0,cv=$('#og-cv'),x=cv.getContext('2d');
   x.fillStyle='#fff';x.fillRect(0,0,200,200);x.drawImage(warp,x0-w/2,y0-h/2,w*2,h*2,0,0,200,200);x.strokeStyle=ACC();x.lineWidth=3;x.strokeRect(50,50,100,100);cv.style.display='block'}
  function out(){let o='',open=false;const L=last();
   if(!$('#og-pp').checked){for(let c=1;c<=L;c++)o+=(grid[c]||[]).map(q=>q==='?'?'［？］':q).join('');$('#og-out').value=o;return}
   for(let c=1;c<=L;c++){const g=(grid[c]||[]).map(v=>v||''),f=g.findIndex(v=>v),l=g.map(v=>!!v).lastIndexOf(true);
    if(f<0){open=false;continue}
    const np=!open||f>=2;if(np&&o&&!o.endsWith('\n'))o+='\n';
    if(np)o+='\u3000'.repeat(f);o+=g.slice(f,l+1).map(q=>q==='?'?'［？］':q).join('');open=l===ROWS-1}
   $('#og-out').value=o}
  $('#og-pp').onchange=out;
  $('#og-apply').onclick=()=>{const text=$('#og-out').value.trim();if(!text)return alert('還沒有辨識結果，請先按「開始辨識」');
   let chars=0,unclear=0;for(let c=1;c<=last();c++)(grid[c]||[]).forEach(v=>{if(v){chars++;if(v==='?')unclear++}});
   const mode=root.querySelector('input[name=og-mode]:checked').value;
   if(opts.hasText&&mode==='replace'&&!confirm('這會取代目前的作文文字，無法復原。確定要取代嗎？\n（要接在後面請改選「接在目前文字後面」）'))return;
   opts.onApply({text:$('#og-out').value,mode,info:{sheet:$('#og-which').value,lines:last(),chars,unclear}});close()};
  $('#og-close').onclick=$('#og-cancel').onclick=()=>{if(!grid.length||confirm('關閉後，這次的辨識結果不會保留。確定關閉？'))close()};
  if((opts.photos||[]).length)loadPhoto();
}
