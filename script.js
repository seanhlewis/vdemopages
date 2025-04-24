/* -------------------- CONFIG ------------------------------------------------------- */
const MODES = ['loading', 'calibration', 'incision',
    'extraction', 'suturing', 'review'];

const COLORS = {
stylus : { r:255, g:255, b:  0 },
hingeL : { r:  0, g:255, b:  0 },
hingeR : { r:255, g:  0, b:  0 }
};
const THRESHOLD  = 40;
const PINCH_DIST = 50;

/* -------------------- GLOBAL STATE ------------------------------------------------ */
let drawArea        = null;
let currentModeIdx  = 0;

let spaceHeld       = false;
const liveMarker    = { stylus:null, hingeL:null, hingeR:null };

let incisionDots    = [];          // red dots (step 2)
let lastPaintPos    = null;
let stitchDots      = [];          // grey stitches (step 4)

let debugMode       = false;
const debugPos      = { stylus:null, hingeL:null, hingeR:null };
const debugPairs    = {};          // {key:{cam,shadow}}

let safeView        = false;

/* -------------------- CANVAS & VIDEO --------------------------------------------- */
const canvas  = document.getElementById('webcam-canvas');
const ctx     = canvas.getContext('2d', { willReadFrequently:true });
const video   = document.createElement('video');
video.autoplay = true; video.playsInline = true;

/* -------------------- CYST SPRITE ------------------------------------------------- */
let cystEl          = null;
const CYST_START_LEFT = '58%';
const CYST_START_TOP  = '41%';

function ensureCyst(){
if(cystEl) return;
cystEl = document.createElement('img');
cystEl.src = 'assets/cyst.png';
cystEl.style.cssText =
`position:fixed;width:90px;left:${CYST_START_LEFT};top:${CYST_START_TOP};`+
'transform:translate(-50%,-50%);pointer-events:none;z-index:25';
document.body.appendChild(cystEl);
}
function resetCyst(){
if(cystEl){
cystEl.style.left = CYST_START_LEFT;
cystEl.style.top  = CYST_START_TOP;
}
}
const showCyst = () => cystEl && (cystEl.style.display='block');
const hideCyst = () => cystEl && (cystEl.style.display='none');
function placeCyst(xCanvas,yCanvas){
if(!cystEl) return;
cystEl.style.left = `${xCanvas / canvas.width  * innerWidth }px`;
cystEl.style.top  = `${yCanvas / canvas.height * innerHeight}px`;
}

/* -------------------- UTILS ------------------------------------------------------- */
const distSq = (r1,g1,b1,r2,g2,b2) =>
(r1-r2)**2 + (g1-g2)**2 + (b1-b2)**2;

function findColour(img, target){
let sx=0, sy=0, n=0, w=img.width, h=img.height, d=img.data;
for(let y=0, pos=0; y<h; y++){
for(let x=0; x<w; x++, pos+=4){
if(distSq(d[pos],d[pos+1],d[pos+2], target.r,target.g,target.b) < THRESHOLD**2){
sx += w - x; sy += y; n++;
}
}
}
return n < 20 ? null : { x:sx/n, y:sy/n };
}
const getPos = (key, col, img) =>
debugMode && debugPos[key] ? debugPos[key] : findColour(img, col);

const pagePos = (xc,yc) => ({
x : xc / canvas.width  * innerWidth,
y : yc / canvas.height * innerHeight
});

/* persistent grey marker */
function updateMarker(key, xc, yc){
const pos = pagePos(xc,yc);
if(!liveMarker[key]){
const el=document.createElement('div');
el.className='cursor';
el.style.cssText='background:#bbb;border:2px solid #555;';
liveMarker[key]=el; document.body.appendChild(el);
}
liveMarker[key].style.left=`${pos.x}px`;
liveMarker[key].style.top =`${pos.y}px`;
if(key==='stylus') liveMarker.stylusCanvas = { x:xc, y:yc };
}

/* -------- linear red paint (step 2) -------- */
function paintLine(xc,yc){
const stride = 4;                       // canvas-px spacing
if(!lastPaintPos){ lastPaintPos={x:xc,y:yc}; paintDot(xc,yc); return; }
const dx = xc - lastPaintPos.x, dy = yc - lastPaintPos.y;
const dist = Math.hypot(dx,dy);
if(dist < stride) return;
const steps = Math.floor(dist/stride);
const ux = dx / dist, uy = dy / dist;
for(let i=1;i<=steps;i++){
paintDot(lastPaintPos.x + ux*stride*i,
  lastPaintPos.y + uy*stride*i);
}
lastPaintPos = {x:xc, y:yc};
}
function paintDot(xc,yc){
const p=pagePos(xc,yc);
const d=document.createElement('div');
d.style.cssText =
'position:fixed;width:6px;height:6px;border-radius:50%;background:#d00;'+
'pointer-events:none;z-index:28;transform:translate(-50%,-50%);';
d.style.left=`${p.x}px`; d.style.top=`${p.y}px`;
document.body.appendChild(d); incisionDots.push(d);
}

/* -------- grey stitch row (step 4) ---------- */
function dropStitch(){
const p = liveMarker.stylusCanvas; if(!p) return;
const base = pagePos(p.x, p.y);
const count = 5, spacing = 6;
for(let i=0;i<count;i++){
const dot = document.createElement('div');
dot.style.cssText =
'position:fixed;width:4px;height:4px;border-radius:50%;background:#444;'+
'pointer-events:none;z-index:28;transform:translate(-50%,-50%);';
dot.style.left=`${base.x - (count-1)*spacing/2 + i*spacing}px`;
dot.style.top =`${base.y}px`;
document.body.appendChild(dot); stitchDots.push(dot);
}
}

/* -------------------- DOM READY -------------------------------------------------- */
document.addEventListener('DOMContentLoaded',()=>{

/* cached refs */
const nextBtn   = document.getElementById('next');
const clearBtn  = document.getElementById('clear');
drawArea        = document.getElementById('draw-area');
const debugBtn  = document.getElementById('debug-btn');
const dbgLayer  = document.getElementById('debug-layer');
const safetyBtn = document.getElementById('safety-btn');
const calibrBtn = document.getElementById('calibrate-btn');
const overlayEl = document.getElementById('safe-overlay');

/* webcam */
navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{
video.srcObject = stream;
video.addEventListener('loadedmetadata',()=>{
canvas.width  = 300;
canvas.height = 300*(video.videoHeight/video.videoWidth);
ctx.translate(canvas.width,0); ctx.scale(-1,1);
switchMode(1);
requestAnimationFrame(drawLoop);
});
});

/* reset visuals between steps */
function resetStep(){
incisionDots.forEach(el=>el.remove()); incisionDots=[];
stitchDots  .forEach(el=>el.remove()); stitchDots=[];
lastPaintPos = null;
if(currentModeIdx===3) resetCyst();     // extraction
}

/* mode switcher */
function switchMode(i){
currentModeIdx = i; resetStep();
const mode = MODES[i];
MODES.forEach(m=>{
document.getElementById(`${m}-screen`)?.classList.toggle('hidden', m!==mode);
document.getElementById(`bg-${m}`)   ?.classList.toggle('hidden', m!==mode);
});
if(mode==='extraction'){ ensureCyst(); showCyst(); } else hideCyst();
}
switchMode(0);

nextBtn .addEventListener('click',()=>switchMode((currentModeIdx+1)%MODES.length));
clearBtn.addEventListener('click',resetStep);  // also resets cyst in step 3

/* space key */
window.addEventListener('keydown',e=>{
if(e.code==='Space'){ e.preventDefault();
if(!spaceHeld && MODES[currentModeIdx]==='suturing') dropStitch();
spaceHeld = true;
}
});
window.addEventListener('keyup',e=>{
if(e.code==='Space'){ e.preventDefault(); spaceHeld=false; lastPaintPos=null; }
});

/* safety / calibrate buttons */
safetyBtn.addEventListener('click',()=>{
safeView = !safeView;
overlayEl.style.opacity = safeView ? 1 : 0;
});
calibrBtn.addEventListener('click',()=>switchMode(1));

/* ---------------- DEBUG MODE ------------------------------------ */
function createDebugPair(key,color){
const cam=document.createElement('div');
cam.className='debug-marker'; cam.style.background=color; dbgLayer.appendChild(cam);

const shadow=document.createElement('div');
shadow.className='debug-shadow'; shadow.style.background=color;
document.body.appendChild(shadow);

const moveTo=(px,py)=>{
const r=dbgLayer.getBoundingClientRect();
const lx=Math.max(0,Math.min(r.width ,px-r.left));
const ly=Math.max(0,Math.min(r.height,py-r.top ));
cam.style.left=`${lx-10}px`; cam.style.top=`${ly-10}px`;
shadow.style.left=`${px}px`; shadow.style.top=`${py}px`;
debugPos[key] = {
x : lx / r.width  * canvas.width,
y : ly / r.height * canvas.height
};
};

cam.addEventListener('mousedown',e=>{
e.preventDefault(); cam.style.cursor='grabbing';
const drag=ev=>moveTo(ev.clientX,ev.clientY);
const up  =()=>{cam.style.cursor='grab';
document.removeEventListener('mousemove',drag);
document.removeEventListener('mouseup',up);};
document.addEventListener('mousemove',drag);
document.addEventListener('mouseup',up);
});

const r0 = dbgLayer.getBoundingClientRect();
moveTo(r0.left+r0.width/2, r0.top+r0.height/2);
debugPairs[key]={cam,shadow};
}
function enableDebug(){
createDebugPair('stylus','#f7e800');
createDebugPair('hingeL','#00ff00');
createDebugPair('hingeR','#ff0000');
}
function disableDebug(){
Object.values(debugPairs).forEach(p=>{p.cam.remove();p.shadow.remove();});
for(const k in debugPairs) delete debugPairs[k];
for(const k in debugPos)   debugPos[k]=null;
}
debugBtn?.addEventListener('click',e=>{
debugMode=!debugMode;
e.currentTarget.style.background = debugMode ? 'rgba(0,0,0,.6)' : 'rgba(0,0,0,.25)';
debugMode ? enableDebug() : disableDebug();
});

/* ---------------- MAIN DRAW LOOP -------------------------------- */
function drawLoop(){
ctx.drawImage(video,0,0,canvas.width,canvas.height);
const img = ctx.getImageData(0,0,canvas.width,canvas.height);

/* always update all three markers */
const stylus = getPos('stylus',COLORS.stylus,img);
const hingeL = getPos('hingeL',COLORS.hingeL ,img);
const hingeR = getPos('hingeR',COLORS.hingeR ,img);

if(stylus){
updateMarker('stylus',stylus.x,stylus.y);
if(MODES[currentModeIdx]==='incision' && spaceHeld)
paintLine(stylus.x,stylus.y);
}
if(hingeL) updateMarker('hingeL',hingeL.x,hingeL.y);
if(hingeR) updateMarker('hingeR',hingeR.x,hingeR.y);

/* pinch-to-move cyst */
if(MODES[currentModeIdx]==='extraction' && hingeL && hingeR &&
Math.hypot(hingeL.x-hingeR.x, hingeL.y-hingeR.y) < PINCH_DIST){
placeCyst((hingeL.x+hingeR.x)/2, (hingeL.y+hingeR.y)/2);
}
requestAnimationFrame(drawLoop);
}
});
