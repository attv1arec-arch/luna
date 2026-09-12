const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const api = async (url, opts={}) => {
  const r = await fetch(url, {headers: opts.body instanceof FormData ? undefined : {'Content-Type':'application/json'}, ...opts});
  if (!r.ok) throw new Error((await r.json().catch(()=>({}))).error || `${r.status} ${r.statusText}`);
  return r.json();
};
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (n,a,b)=>Math.max(a,Math.min(b,Number(n)||0));
const esc = s => String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));

const defaults = () => ({
  profile:{name:'Adobe Color',amount:100,adaptive:false},
  light:{exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0},
  color:{temperature:0,tint:0,vibrance:0,saturation:0,bw:false,mixer:{red:{hue:0,saturation:0,luminance:0},orange:{hue:0,saturation:0,luminance:0},yellow:{hue:0,saturation:0,luminance:0},green:{hue:0,saturation:0,luminance:0},aqua:{hue:0,saturation:0,luminance:0},blue:{hue:0,saturation:0,luminance:0},purple:{hue:0,saturation:0,luminance:0},magenta:{hue:0,saturation:0,luminance:0}},pointColors:[]},
  effects:{texture:0,clarity:0,dehaze:0,vignette:0,vignetteMidpoint:50,vignetteRoundness:0,vignetteFeather:50,vignetteHighlights:0,grain:0,grainSize:25,grainRoughness:50},
  detail:{sharpen:25,radius:1,detail:25,masking:0,luminanceNR:0,luminanceDetail:50,luminanceContrast:0,colorNR:25,colorDetail:50,colorSmoothness:50},
  optics:{chromaticAberration:true,profileCorrections:true,lensMake:'',lensModel:'',lensProfile:'',distortion:0,vignette:0,defringePurple:0,defringeGreen:0},
  geometry:{upright:'off',guides:[],vertical:0,horizontal:0,rotate:0,aspect:0,scale:100,x:0,y:0,constrainCrop:true},
  crop:{ratio:'free',x:0,y:0,width:1,height:1,angle:0,rotate90:0,flipX:false,flipY:false,overlay:'thirds'},
  curves:{rgb:[[0,0],[1,1]],red:[[0,0],[1,1]],green:[[0,0],[1,1]],blue:[[0,0],[1,1]],refineSaturation:100},
  grading:{shadows:{h:0,s:0,l:0},mids:{h:0,s:0,l:0},highlights:{h:0,s:0,l:0},global:{h:0,s:0,l:0},blending:50,balance:0},
  calibration:{shadowTint:0,redHue:0,redSat:0,greenHue:0,greenSat:0,blueHue:0,blueSat:0},
  masks:[], retouch:[], redEye:[], ai:{lensBlur:null,enhance:null}
});

const state = {
  photos:[], albums:[], presets:[], selectedId:null, workspace:'library', view:'all', currentAlbum:null,
  history:[], future:[], sourceImage:null, sourceId:null, renderToken:0, before:false, zoom:'fit', activeMask:null, selectedIds:new Set(),
  panel:'edit'
};

const editCanvas = $('#editCanvas'), ctx = editCanvas.getContext('2d',{willReadFrequently:true});
const overlay = $('#overlayCanvas'), octx = overlay.getContext('2d');
const histCanvas = $('#histogram'), hctx = histCanvas.getContext('2d');
let toastTimer;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.classList.remove('show'),2200); }
function photo(){ return state.photos.find(p=>p.id===state.selectedId); }
function previewUrl(p){ return `/media/preview/${p.id}.jpg`; }
function thumbUrl(p){ return `/media/thumb/${p.id}.jpg`; }
function originalUrl(p){ return `/media/original/${encodeURIComponent(p.originalPath)}`; }
function debounce(fn,ms=350){let t;return(...a)=>{clearTimeout(t);t=setTimeout(()=>fn(...a),ms)}}
const savePhotoDebounced = debounce(async p=>{ try{await api(`/api/photos/${p.id}`,{method:'PATCH',body:JSON.stringify({edits:p.edits})}); if(state.panel==='edit'&&!state.before) refreshHQPreview(p);}catch(e){toast(e.message)} },600);

async function boot(){
  try{
    const data = await api('/api/state');
    state.photos = data.photos || []; state.albums=data.albums||[]; state.presets=data.presets||[]; state.smartAlbums=data.smartAlbums||[]; state.settings=data.settings||{};
    state.selectedId = state.photos[0]?.id || null; if(state.selectedId) state.selectedIds.add(state.selectedId);
    renderLibrary(); renderAlbums(); renderFilmstrip(); renderRightPanel();
    if (state.selectedId) loadSelectedImage();
  }catch(e){ $('#storageStatus').textContent='Offline'; toast(`Could not load library: ${e.message}`); }
}

function filteredPhotos(){
  let items=state.view==='trash'?[...(state.trashPhotos||[])]:[...state.photos];
  if(state.view==='favorites') items=items.filter(p=>p.favorite);
  if(state.view==='picks') items=items.filter(p=>p.flag==='pick');
  if(state.view==='rejected') items=items.filter(p=>p.flag==='reject');

  if(state.view==='album' && state.currentAlbum){ const a=state.albums.find(a=>a.id===state.currentAlbum); items=items.filter(p=>a?.photoIds.includes(p.id)); }
  if(state.view==='smart' && state.currentAlbum) items=[...(state.smartPhotos||[])];
  const q=$('#searchInput').value.trim().toLowerCase();
  if(q) items=items.filter(p=>[p.name,p.title,p.caption,p.copyright,...(p.keywords||[]),p.meta?.camera,p.meta?.lens,JSON.stringify(p.meta?.exif||{})].join(' ').toLowerCase().includes(q));
  const r=+$('#ratingFilter').value; if(r) items=items.filter(p=>p.rating>=r);
  const sort=$('#sortSelect').value;
  if(sort==='imported-desc') items.sort((a,b)=>new Date(b.importedAt)-new Date(a.importedAt));
  if(sort==='imported-asc') items.sort((a,b)=>new Date(a.importedAt)-new Date(b.importedAt));
  if(sort==='name-asc') items.sort((a,b)=>a.name.localeCompare(b.name));
  if(sort==='rating-desc') items.sort((a,b)=>b.rating-a.rating);
  return items;
}

function renderLibrary(){
  const items=filteredPhotos(); $('#allCount').textContent=state.photos.length; $('#emptyState').classList.toggle('hidden',state.photos.length>0);
  $('#photoGrid').innerHTML=items.map(p=>`<article class="photo-card ${p.id===state.selectedId?'selected':''} ${state.selectedIds.has(p.id)?'multi-selected':''}" data-id="${p.id}">
    <img src="${thumbUrl(p)}" loading="lazy" alt="${esc(p.name)}">
    ${p.flag!=='none'?`<span class="badge">${p.flag==='pick'?'PICK':'REJECT'}</span>`:''}${p.favorite?'<span class="fav">♥</span>':''}
    <div class="photo-meta"><span class="name">${esc(p.name)}</span><span class="rating">${'★'.repeat(p.rating||0)}</span></div></article>`).join('');
  $$('.photo-card').forEach(el=>el.onclick=(ev)=>selectPhoto(el.dataset.id,true,ev.ctrlKey||ev.metaKey));
}
function renderAlbums(){
  $('#albumList').innerHTML=state.albums.map(a=>`<button class="nav-item ${state.view==='album'&&state.currentAlbum===a.id?'active':''}" data-album="${a.id}"><span>▣</span>${esc(a.name)}<em>${a.photoIds.length}</em></button>`).join('') + (state.smartAlbums||[]).map(a=>`<button class="nav-item ${state.view==='smart'&&state.currentAlbum===a.id?'active':''}" data-smart="${a.id}"><span>◇</span>${esc(a.name)}<em>smart</em></button>`).join('');
  $$('[data-album]').forEach(b=>b.onclick=()=>{state.view='album';state.currentAlbum=b.dataset.album;$$('.nav-item[data-view]').forEach(x=>x.classList.remove('active'));renderAlbums();renderLibrary();});
  $$('[data-smart]').forEach(b=>b.onclick=async()=>{state.view='smart';state.currentAlbum=b.dataset.smart;state.smartPhotos=await api(`/api/smart-albums/${b.dataset.smart}/photos`);renderAlbums();renderLibrary();});
}
function renderFilmstrip(){
  $('#filmstrip').innerHTML=state.photos.slice(0,100).map(p=>`<img data-id="${p.id}" class="${p.id===state.selectedId?'active':''}" src="${thumbUrl(p)}" title="${esc(p.name)}">`).join('');
  $$('#filmstrip img').forEach(i=>i.onclick=()=>selectPhoto(i.dataset.id,false));
}
async function selectPhoto(id,openEditor=false,multi=false){
  if(multi){ if(state.selectedIds.has(id)) state.selectedIds.delete(id); else state.selectedIds.add(id); if(!state.selectedIds.size)state.selectedIds.add(id); } else { state.selectedIds=new Set([id]); }
  state.selectedId=id; state.history=[];state.future=[]; state.before=false;
  renderLibrary();renderFilmstrip();renderRightPanel(); await loadSelectedImage();
  if(openEditor) setWorkspace('edit');
}

async function uploadFiles(files){
  files=[...files]; if(!files.length)return;
  const fd=new FormData(); files.forEach(f=>fd.append('photos',f)); toast(`Importing ${files.length} photo${files.length>1?'s':''}…`);
  try{
    const data=await api('/api/photos',{method:'POST',body:fd}); const ok=data.items.filter(x=>!x.error); state.photos=[...ok,...state.photos];
    if(ok[0]) {state.selectedId=ok[0].id;state.selectedIds=new Set([ok[0].id]);} renderLibrary();renderFilmstrip();renderRightPanel(); if(ok[0])await loadSelectedImage(); toast(`Imported ${ok.length} photo${ok.length!==1?'s':''}`);
  }catch(e){toast(`Import failed: ${e.message}`)}
}

function setWorkspace(w){
  state.workspace=w; $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.workspace===w));
  const library=w==='library'; $('#libraryView').classList.toggle('active',library); $('#editorView').classList.toggle('active',!library);
  state.panel=w==='mask'?'mask':w==='retouch'?'retouch':'edit'; renderRightPanel(); if(!library&&photo()) renderPreview();
}

function pushHistory(){ const p=photo(); if(!p)return; state.history.push(clone(p.edits)); if(state.history.length>60)state.history.shift(); state.future=[]; }
function mutate(path,value,{history=true}={}){
  const p=photo(); if(!p)return; if(history)pushHistory(); let o=p.edits; const parts=path.split('.'); for(let i=0;i<parts.length-1;i++)o=o[parts[i]]; o[parts.at(-1)]=value; p.modifiedAt=new Date().toISOString(); savePhotoDebounced(p); renderPreview();
}
function undo(){const p=photo();if(!p||!state.history.length)return;state.future.push(clone(p.edits));p.edits=state.history.pop();savePhotoDebounced(p);renderRightPanel();renderPreview()}
function redo(){const p=photo();if(!p||!state.future.length)return;state.history.push(clone(p.edits));p.edits=state.future.pop();savePhotoDebounced(p);renderRightPanel();renderPreview()}

async function loadSelectedImage(){
  const p=photo(); if(!p)return; $('#viewerTitle').textContent=p.name;
  const img=new Image(); img.crossOrigin='anonymous'; img.onload=()=>{state.sourceImage=img;state.sourceId=p.id;renderPreview();}; img.src=previewUrl(p)+'?v='+encodeURIComponent(p.modifiedAt||p.importedAt);
}

function computeTargetSize(img){
  const stage=$('#canvasStage').getBoundingClientRect(); const maxW=Math.max(200,stage.width-32),maxH=Math.max(200,stage.height-32);
  let scale=Math.min(maxW/img.width,maxH/img.height,1); if(state.zoom==='100')scale=1;
  return {w:Math.max(1,Math.round(img.width*scale)),h:Math.max(1,Math.round(img.height*scale)),scale};
}

function renderPreview(){
  const p=photo(),img=state.sourceImage;if(!p||!img||state.sourceId!==p.id)return;
  const token=++state.renderToken; requestAnimationFrame(()=>{ if(token!==state.renderToken)return; renderPreviewNow(p,img); });
}

function renderPreviewNow(p,img){
  const e=state.before?defaults():p.edits||defaults(); const {w,h}=computeTargetSize(img); const rot=((e.crop.rotate90||0)%360+360)%360;
  const rotated=rot===90||rot===270; editCanvas.width=rotated?h:w;editCanvas.height=rotated?w:h; overlay.width=editCanvas.width;overlay.height=editCanvas.height;
  const c=ctx; c.save();c.clearRect(0,0,editCanvas.width,editCanvas.height);c.translate(editCanvas.width/2,editCanvas.height/2);c.rotate((rot+e.crop.angle)*Math.PI/180);c.scale(e.crop.flipX?-1:1,e.crop.flipY?-1:1);
  const brightness=Math.pow(2,clamp(e.light.exposure,-5,5))* (1+(e.light.whites||0)/600+(e.light.shadows||0)/900);
  const contrast=100+clamp(e.light.contrast,-100,100)*.72; const sat=100+clamp((e.color.saturation||0)+(e.color.vibrance||0)*.55,-100,180);
  const temp=e.color.temperature||0,tint=e.color.tint||0; const hue=tint*.12; const blur=(e.detail.luminanceNR||0)*.006;
  c.filter=`brightness(${Math.max(.05,brightness)}) contrast(${Math.max(0,contrast)}%) saturate(${Math.max(0,sat)}%) hue-rotate(${hue}deg) ${blur>0?`blur(${blur}px)`:''}`;
  c.drawImage(img,-w/2,-h/2,w,h);c.restore();c.filter='none';
  let data=c.getImageData(0,0,editCanvas.width,editCanvas.height); applyPixelEdits(data,e); c.putImageData(data,0,0);
  drawMasks(p,e); updateHistogram(data); applyCanvasTransform(e); $('#overlayCanvas').style.display=(state.panel==='mask'||state.panel==='retouch')?'block':'none';
}

function applyPixelEdits(imageData,e){
  const d=imageData.data; const shadows=(e.light.shadows||0)/100, highlights=(e.light.highlights||0)/100, blacks=(e.light.blacks||0)/100, whites=(e.light.whites||0)/100;
  const temp=(e.color.temperature||0)/100,tint=(e.color.tint||0)/100,clarity=(e.effects.clarity||0)/100,dehaze=(e.effects.dehaze||0)/100, vignette=(e.effects.vignette||0)/100;
  const grain=e.effects.grain||0, bw=e.color.bw; const W=imageData.width,H=imageData.height;
  for(let i=0;i<d.length;i+=4){
    let r=d[i]/255,g=d[i+1]/255,b=d[i+2]/255; let lum=.2126*r+.7152*g+.0722*b;
    const sh=(1-lum)*(1-lum)*shadows*.32, hi=lum*lum*highlights*.26; r+=sh+hi;g+=sh+hi;b+=sh+hi;
    r+=whites*Math.max(0,lum-.55)*.18 + blacks*Math.max(0,.45-lum)*.16;g+=whites*Math.max(0,lum-.55)*.18 + blacks*Math.max(0,.45-lum)*.16;b+=whites*Math.max(0,lum-.55)*.18 + blacks*Math.max(0,.45-lum)*.16;
    r+=temp*.085+tint*.025; b-=temp*.085; g-=Math.abs(tint)*.022; b+=tint*.02;
    lum=.2126*r+.7152*g+.0722*b; const local=(lum-.5)*(clarity*.22+dehaze*.18); r+=local;g+=local;b+=local;
    if(bw){const y=.2126*r+.7152*g+.0722*b;r=g=b=y;}
    if(vignette){const px=((i/4)%W)/(W-1)-.5,py=Math.floor(i/4/W)/(H-1)-.5;const dist=Math.min(1,Math.sqrt(px*px+py*py)*1.55);const v=1+vignette*dist*dist*.65;r*=v;g*=v;b*=v;}
    if(grain){const n=(Math.random()-.5)*(grain/100)*.12;r+=n;g+=n;b+=n;}
    d[i]=clamp(r*255,0,255);d[i+1]=clamp(g*255,0,255);d[i+2]=clamp(b*255,0,255);
  }
}
function applyCanvasTransform(e){
  const g=e.geometry||{}; const scale=(g.scale||100)/100; const sx=scale*(1+(g.horizontal||0)/500),sy=scale*(1+(g.vertical||0)/500);
  const tr=`translate(${g.x||0}px,${g.y||0}px) skew(${(g.horizontal||0)*.08}deg,${(g.vertical||0)*.08}deg) scale(${sx},${sy})`;
  editCanvas.style.transform=tr;overlay.style.transform=tr;
}
function updateHistogram(imageData){
  const binsR=new Uint32Array(64),binsG=new Uint32Array(64),binsB=new Uint32Array(64),d=imageData.data;
  for(let i=0;i<d.length;i+=16){binsR[d[i]>>2]++;binsG[d[i+1]>>2]++;binsB[d[i+2]>>2]++;}
  const max=Math.max(...binsR,...binsG,...binsB,1),W=histCanvas.width,H=histCanvas.height;hctx.clearRect(0,0,W,H);hctx.globalCompositeOperation='screen';
  [[binsR,'#ff5a5a'],[binsG,'#5dff86'],[binsB,'#5f8fff']].forEach(([bins,color])=>{hctx.strokeStyle=color;hctx.globalAlpha=.72;hctx.beginPath();bins.forEach((n,i)=>{const x=i/(bins.length-1)*W,y=H-(n/max)*(H-5);i?hctx.lineTo(x,y):hctx.moveTo(x,y)});hctx.stroke()});hctx.globalCompositeOperation='source-over';hctx.globalAlpha=1;
}
function drawMasks(p,e){
  octx.clearRect(0,0,overlay.width,overlay.height); if(state.panel==='retouch'){octx.save();for(const op of e.retouch||[]){octx.strokeStyle=op.type==='clone'?'#62b0ff':'#ff7a82';octx.lineWidth=2;octx.beginPath();octx.arc(op.x*overlay.width,op.y*overlay.height,(op.size||.03)*Math.min(overlay.width,overlay.height),0,Math.PI*2);octx.stroke();}for(const op of e.redEye||[]){octx.strokeStyle='#ff4040';octx.beginPath();octx.arc(op.x*overlay.width,op.y*overlay.height,(op.size||.03)*Math.min(overlay.width,overlay.height),0,Math.PI*2);octx.stroke();}octx.restore();return;} if(state.panel!=='mask')return; const masks=e.masks||[];
  for(const m of masks){octx.save();octx.fillStyle='rgba(255,60,70,.22)';octx.strokeStyle='rgba(255,115,120,.8)';
    if(m.type==='radial'){octx.beginPath();octx.ellipse(m.x*overlay.width,m.y*overlay.height,m.rx*overlay.width,m.ry*overlay.height,0,0,Math.PI*2);octx.fill();octx.stroke();}
    if(m.type==='linear'){const x=m.x*overlay.width;octx.fillRect(0,0,x,overlay.height);octx.strokeRect(x-1,0,2,overlay.height);}
    if(m.type==='brush'){for(const pt of m.points||[]){octx.beginPath();octx.arc(pt.x*overlay.width,pt.y*overlay.height,(m.size||.05)*Math.min(overlay.width,overlay.height),0,Math.PI*2);octx.fill();}}
    octx.restore();
  }
}

function slider(path,label,min,max,step,value){return `<div class="control"><label>${label}</label><input type="range" data-edit="${path}" min="${min}" max="${max}" step="${step}" value="${value}"><output>${value}</output></div>`}
function details(title,body,open=true){return `<details class="panel-section" ${open?'open':''}><summary>${title}</summary><div class="section-body">${body}</div></details>`}
function editPanel(){
  const p=photo();if(!p)return '<div class="section-body muted">Select a photo to edit.</div>'; const e=p.edits||defaults();
  const labels=['','red','orange','yellow','green','blue','purple']; const mix=(state.mixerColor||'red'); const mc=e.color.mixer?.[mix]||{hue:0,saturation:0,luminance:0};
  const grade=(name,label)=>`<div class="subhead">${label}</div>${slider(`grading.${name}.h`,'Hue',0,360,1,e.grading[name].h)}${slider(`grading.${name}.s`,'Saturation',0,100,1,e.grading[name].s)}${slider(`grading.${name}.l`,'Luminance',-100,100,1,e.grading[name].l)}`;
  let html=details('Photo',`<div class="stars">${[1,2,3,4,5].map(n=>`<span class="star ${p.rating>=n?'on':''}" data-rating="${n}">★</span>`).join('')}</div><div class="button-row"><button class="mini-btn ${p.flag==='pick'?'active':''}" data-flag="pick">Pick</button><button class="mini-btn ${p.flag==='none'?'active':''}" data-flag="none">Unflag</button><button class="mini-btn ${p.flag==='reject'?'active':''}" data-flag="reject">Reject</button><button class="mini-btn ${p.favorite?'active':''}" id="favBtn">♥ Favorite</button><button class="mini-btn" id="virtualCopyBtn">Virtual Copy</button></div><div class="label-dots">${labels.map(l=>`<span class="label-dot ${l||'none'} ${p.colorLabel===l?'active':''}" data-label="${l}" style="${l?`background:${l}`:''}"></span>`).join('')}</div>`,true);
  html+=details('Profile',`<select id="profileSelect" class="select"><option>Adobe Color</option><option>Adobe Neutral</option><option>Adobe Vivid</option><option>Adobe Portrait</option><option>Adobe Landscape</option><option>Monochrome</option><option>Adaptive</option></select>${slider('profile.amount','Profile Amount',0,200,1,e.profile?.amount??100)}`);
  html+=details('Light',`<div class="button-row"><button class="mini-btn" id="autoLightBtn">Auto</button></div>`+slider('light.exposure','Exposure',-5,5,.05,e.light.exposure)+slider('light.contrast','Contrast',-100,100,1,e.light.contrast)+slider('light.highlights','Highlights',-100,100,1,e.light.highlights)+slider('light.shadows','Shadows',-100,100,1,e.light.shadows)+slider('light.whites','Whites',-100,100,1,e.light.whites)+slider('light.blacks','Blacks',-100,100,1,e.light.blacks));
  html+=details('Color',`<div class="button-row"><button class="mini-btn ${e.color.bw?'active':''}" id="bwBtn">B&W</button><button class="mini-btn" id="autoColorBtn">Auto Light & Color</button></div>`+slider('color.temperature','Temperature',-100,100,1,e.color.temperature)+slider('color.tint','Tint',-100,100,1,e.color.tint)+slider('color.vibrance','Vibrance',-100,100,1,e.color.vibrance)+slider('color.saturation','Saturation',-100,100,1,e.color.saturation)+`<div class="subhead">Color Mixer</div><select class="select" id="mixerColor">${['red','orange','yellow','green','aqua','blue','purple','magenta'].map(x=>`<option ${x===mix?'selected':''}>${x[0].toUpperCase()+x.slice(1)}</option>`).join('')}</select>${slider('mixer.hue','Hue',-100,100,1,mc.hue)}${slider('mixer.saturation','Saturation',-100,100,1,mc.saturation)}${slider('mixer.luminance','Luminance',-100,100,1,mc.luminance)}<div class="button-row"><button class="mini-btn" id="pointColorBtn">Add Point Color</button></div>`);
  html+=details('Tone Curve',`${slider('curvesMid','Master Midpoint',-100,100,1,Math.round(((e.curves.rgb?.[1]?.[1]??.5)-.5)*200))}<div class="button-row"><button class="mini-btn" data-curve="linear">Linear</button><button class="mini-btn" data-curve="medium">Medium Contrast</button><button class="mini-btn" data-curve="strong">Strong Contrast</button><button class="mini-btn" data-curve="matte">Matte</button></div>`,false);
  html+=details('Color Grading',grade('shadows','Shadows')+grade('mids','Midtones')+grade('highlights','Highlights')+grade('global','Global')+slider('grading.balance','Balance',-100,100,1,e.grading.balance)+slider('grading.blending','Blending',0,100,1,e.grading.blending),false);
  html+=details('Effects',slider('effects.texture','Texture',-100,100,1,e.effects.texture)+slider('effects.clarity','Clarity',-100,100,1,e.effects.clarity)+slider('effects.dehaze','Dehaze',-100,100,1,e.effects.dehaze)+slider('effects.vignette','Vignette',-100,100,1,e.effects.vignette)+slider('effects.vignetteMidpoint','Midpoint',0,100,1,e.effects.vignetteMidpoint??50)+slider('effects.vignetteRoundness','Roundness',-100,100,1,e.effects.vignetteRoundness??0)+slider('effects.vignetteFeather','Feather',0,100,1,e.effects.vignetteFeather??50)+slider('effects.vignetteHighlights','Highlights',0,100,1,e.effects.vignetteHighlights??0)+slider('effects.grain','Grain',0,100,1,e.effects.grain)+slider('effects.grainSize','Grain Size',0,100,1,e.effects.grainSize)+slider('effects.grainRoughness','Roughness',0,100,1,e.effects.grainRoughness));
  html+=details('Detail',slider('detail.sharpen','Sharpening',0,150,1,e.detail.sharpen)+slider('detail.radius','Radius',.5,3,.1,e.detail.radius)+slider('detail.detail','Detail',0,100,1,e.detail.detail)+slider('detail.masking','Masking',0,100,1,e.detail.masking)+slider('detail.luminanceNR','Luminance NR',0,100,1,e.detail.luminanceNR)+slider('detail.luminanceDetail','Luma Detail',0,100,1,e.detail.luminanceDetail??50)+slider('detail.luminanceContrast','Luma Contrast',0,100,1,e.detail.luminanceContrast??0)+slider('detail.colorNR','Color NR',0,100,1,e.detail.colorNR)+slider('detail.colorDetail','Color Detail',0,100,1,e.detail.colorDetail??50)+slider('detail.colorSmoothness','Color Smoothness',0,100,1,e.detail.colorSmoothness??50));
  html+=details('Optics',`<div class="toggle-row"><button class="mini-btn ${e.optics.chromaticAberration?'active':''}" data-toggle="optics.chromaticAberration">Remove CA</button><button class="mini-btn ${e.optics.profileCorrections?'active':''}" data-toggle="optics.profileCorrections">Lens Profile</button></div><input class="meta-input" id="lensMake" placeholder="Lens make" value="${esc(e.optics.lensMake||'')}"><input class="meta-input" id="lensModel" placeholder="Lens model" value="${esc(e.optics.lensModel||'')}">`+slider('optics.distortion','Distortion',-100,100,1,e.optics.distortion)+slider('optics.vignette','Lens Vignette',-100,100,1,e.optics.vignette??0)+slider('optics.defringePurple','Purple Defringe',0,100,1,e.optics.defringePurple)+slider('optics.defringeGreen','Green Defringe',0,100,1,e.optics.defringeGreen),false);
  html+=details('Geometry',slider('geometry.vertical','Vertical',-100,100,1,e.geometry.vertical)+slider('geometry.horizontal','Horizontal',-100,100,1,e.geometry.horizontal)+slider('geometry.rotate','Rotate',-45,45,.1,e.geometry.rotate)+slider('geometry.aspect','Aspect',-100,100,1,e.geometry.aspect)+slider('geometry.scale','Scale',50,150,1,e.geometry.scale)+slider('geometry.x','X Offset',-100,100,1,e.geometry.x)+slider('geometry.y','Y Offset',-100,100,1,e.geometry.y)+`<div class="button-row"><button class="mini-btn" data-upright="auto">Auto</button><button class="mini-btn" data-upright="level">Level</button><button class="mini-btn" data-upright="vertical">Vertical</button><button class="mini-btn" data-upright="full">Full</button><button class="mini-btn" data-upright="guided">Guided</button></div>`,false);
  html+=details('Calibration',slider('calibration.shadowTint','Shadow Tint',-100,100,1,e.calibration?.shadowTint??0)+slider('calibration.redHue','Red Primary Hue',-100,100,1,e.calibration?.redHue??0)+slider('calibration.redSat','Red Primary Sat',-100,100,1,e.calibration?.redSat??0)+slider('calibration.greenHue','Green Primary Hue',-100,100,1,e.calibration?.greenHue??0)+slider('calibration.greenSat','Green Primary Sat',-100,100,1,e.calibration?.greenSat??0)+slider('calibration.blueHue','Blue Primary Hue',-100,100,1,e.calibration?.blueHue??0)+slider('calibration.blueSat','Blue Primary Sat',-100,100,1,e.calibration?.blueSat??0),false);
  html+=details('Crop & Transform',`<select class="select" id="cropRatio"><option value="free">Free</option><option value="1:1">1:1</option><option value="4:3">4:3</option><option value="3:2">3:2</option><option value="16:9">16:9</option></select><div class="button-row"><button class="mini-btn" id="rotateLeft">↶ 90°</button><button class="mini-btn" id="rotateRight">↷ 90°</button><button class="mini-btn ${e.crop.flipX?'active':''}" id="flipX">Flip H</button><button class="mini-btn ${e.crop.flipY?'active':''}" id="flipY">Flip V</button></div>`+slider('crop.angle','Straighten',-45,45,.1,e.crop.angle)+slider('crop.x','Crop X',0,1,.005,e.crop.x)+slider('crop.y','Crop Y',0,1,.005,e.crop.y)+slider('crop.width','Crop Width',.05,1,.005,e.crop.width)+slider('crop.height','Crop Height',.05,1,.005,e.crop.height),false);
  html+=details('Enhance / AI',`<div class="button-row"><button class="mini-btn ai-provider" data-ai-feature="lens-blur-depth">Lens Blur</button><button class="mini-btn ai-provider" data-ai-feature="denoise">AI Denoise</button><button class="mini-btn ai-provider" data-ai-feature="raw-details">Raw Details</button><button class="mini-btn ai-provider" data-ai-feature="super-resolution">Super Resolution</button><button class="mini-btn ai-provider" data-ai-feature="ai-sharpen">AI Sharpen</button><button class="mini-btn ai-provider" data-ai-feature="assisted-culling">Assisted Culling</button><button class="mini-btn ai-provider" data-ai-feature="recommended-presets">Recommended Presets</button><button class="mini-btn ai-provider" data-ai-feature="adaptive-presets">Adaptive Presets</button><button class="mini-btn ai-provider" data-ai-feature="adaptive-profiles">Adaptive Profiles</button></div><p class="muted">Runs the bundled local PyTorch/Transformers/Diffusers engines on the Render service.</p>`,false);
  html+=details('Metadata',metadataPanel(false),false); return html;
}

function metadataPanel(full=true){ const p=photo();if(!p)return '';const m=p.meta||{};return `${full?'<div class="subhead">Editable</div>':''}<input class="meta-input" id="titleInput" value="${esc(p.title)}" placeholder="Title"><textarea class="meta-input area" id="captionInput" placeholder="Caption">${esc(p.caption)}</textarea><input class="meta-input" id="keywordsInput" value="${esc((p.keywords||[]).join(', '))}" placeholder="Keywords, comma separated"><input class="meta-input" id="copyrightInput" value="${esc(p.copyright)}" placeholder="Copyright"><div class="subhead">File</div><div class="meta-table"><b>Name</b><span>${esc(p.name)}</span><b>Dimensions</b><span>${m.width||'?'} × ${m.height||'?'}</span><b>Format</b><span>${esc((m.format||p.ext||'').toUpperCase())}</span><b>Color space</b><span>${esc(m.space||'—')}</span><b>Imported</b><span>${new Date(p.importedAt).toLocaleString()}</span><b>Modified</b><span>${new Date(p.modifiedAt).toLocaleString()}</span></div>`}

function presetsPanel(){const p=photo();if(!p)return '<div class="section-body muted">Select a photo.</div>';return `<div class="section-body"><button class="btn primary" id="savePresetBtn">Save current edits as preset</button><div class="subhead">Your presets</div>${state.presets.length?state.presets.map(x=>`<div class="preset-card" data-preset="${x.id}"><b>${esc(x.name)}</b><small>${new Date(x.createdAt).toLocaleDateString()}</small></div>`).join(''):'<p class="muted">No presets yet.</p>'}</div>`}
function versionsPanel(){const p=photo();if(!p)return '<div class="section-body muted">Select a photo.</div>';return `<div class="section-body"><button class="btn primary" id="saveVersionBtn">Create named version</button><div class="subhead">Versions</div>${p.versions?.length?p.versions.map(v=>`<div class="version-card" data-version="${v.id}"><b>${esc(v.name)}</b><small>${new Date(v.createdAt).toLocaleString()}</small></div>`).join(''):'<p class="muted">No saved versions yet.</p>'}</div>`}
function maskPanel(){const p=photo();if(!p)return '<div class="section-body muted">Select a photo.</div>'; const masks=p.edits.masks||[],active=masks.find(m=>m.id===state.activeMask)||masks[0];if(active&&!state.activeMask)state.activeMask=active.id; const a=active?.adjustments||{};return `<div class="section-body"><div class="button-row"><button class="mini-btn" data-new-mask="brush">Brush</button><button class="mini-btn" data-new-mask="linear">Linear Gradient</button><button class="mini-btn" data-new-mask="radial">Radial Gradient</button><button class="mini-btn" data-new-mask="luminance">Luminance Range</button><button class="mini-btn" data-new-mask="color">Color Range</button></div><div class="subhead">AI selections</div><div class="button-row"><button class="mini-btn ai-mask" data-ai="subject">Subject</button><button class="mini-btn ai-mask" data-ai="sky">Sky</button><button class="mini-btn ai-mask" data-ai="background">Background</button><button class="mini-btn ai-mask" data-ai="people">People</button><button class="mini-btn ai-mask" data-ai="object">Object</button><button class="mini-btn ai-mask" data-ai="landscape">Landscape</button></div>${active?`<div class="subhead">Active Mask Adjustments</div>${slider('mask.exposure','Exposure',-5,5,.05,a.exposure||0)}${slider('mask.contrast','Contrast',-100,100,1,a.contrast||0)}${slider('mask.highlights','Highlights',-100,100,1,a.highlights||0)}${slider('mask.shadows','Shadows',-100,100,1,a.shadows||0)}${slider('mask.temperature','Temperature',-100,100,1,a.temperature||0)}${slider('mask.tint','Tint',-100,100,1,a.tint||0)}${slider('mask.saturation','Saturation',-100,100,1,a.saturation||0)}${slider('mask.texture','Texture',-100,100,1,a.texture||0)}${slider('mask.clarity','Clarity',-100,100,1,a.clarity||0)}${slider('mask.dehaze','Dehaze',-100,100,1,a.dehaze||0)}${slider('mask.sharpness','Sharpness',-100,100,1,a.sharpness||0)}${slider('mask.noise','Noise',0,100,1,a.noise||0)}`:''}<div class="subhead">Masks</div>${masks.length?masks.map(m=>`<div class="mask-card ${m.id===state.activeMask?'active':''}" data-select-mask="${m.id}"><b>${esc(m.name||m.type)}</b><div class="button-row"><button class="mini-btn" data-invert-mask="${m.id}">Invert</button><button class="mini-btn" data-delete-mask="${m.id}">Delete</button></div></div>`).join(''):'<p class="muted">No masks yet.</p>'}</div>`}
function retouchPanel(){const p=photo();if(!p)return '<div class="section-body muted">Select a photo.</div>';return `<div class="section-body"><div class="button-row"><button class="mini-btn ${state.retouchTool==='heal'?'active':''}" id="healTool">Heal</button><button class="mini-btn ${state.retouchTool==='clone'?'active':''}" id="cloneTool">Clone</button><button class="mini-btn ${state.retouchTool==='content-aware'?'active':''}" id="contentAwareTool">Content-aware</button><button class="mini-btn ${state.retouchTool==='red-eye'?'active':''}" id="redEyeTool">Red Eye</button></div><div class="control"><label>Brush Size</label><input id="retouchSize" type="range" min=".005" max=".15" step=".005" value="${state.retouchSize||.035}"><output>${Math.round((state.retouchSize||.035)*1000)/10}%</output></div><p class="muted">Choose a tool and click the photograph. Clone samples from a nearby offset; source coordinates are stored non-destructively.</p><div class="subhead">AI Retouch</div><div class="button-row"><button class="mini-btn ai-provider" data-ai-feature="generative-remove">Generative Remove</button><button class="mini-btn ai-provider" data-ai-feature="distraction-people">Remove People</button><button class="mini-btn ai-provider" data-ai-feature="distraction-reflections">Remove Reflections</button><button class="mini-btn ai-provider" data-ai-feature="distraction-dust">Remove Dust</button><button class="mini-btn ai-provider" data-ai-feature="blemish-retouch">Blemish Retouch</button></div><div class="subhead">Corrections</div><p class="muted">${(p.edits.retouch||[]).length} retouch operations • ${(p.edits.redEye||[]).length} red-eye corrections</p><button class="mini-btn" id="clearRetouch">Clear retouching</button></div>`}

function renderRightPanel(){
  let content=''; if(state.panel==='presets'){content=presetsPanel();$('#panelTitle').textContent='Presets'} else if(state.panel==='versions'){content=versionsPanel();$('#panelTitle').textContent='Versions'} else if(state.panel==='metadata'){content=`<div class="section-body">${metadataPanel(true)}</div>`;$('#panelTitle').textContent='Metadata'} else if(state.panel==='mask'){content=maskPanel();$('#panelTitle').textContent='Masking'} else if(state.panel==='retouch'){content=retouchPanel();$('#panelTitle').textContent='Retouch'} else {content=editPanel();$('#panelTitle').textContent='Edit'}
  $('#rightPanelContent').innerHTML=content; bindPanel();
}

function getPath(obj,path){return path.split('.').reduce((o,k)=>o?.[k],obj)}
function setPath(obj,path,val){const parts=path.split('.');for(let i=0;i<parts.length-1;i++)obj=obj[parts[i]];obj[parts.at(-1)]=val}
function bindPanel(){
  $$('[data-edit]').forEach(inp=>{ inp.onpointerdown=()=>{inp.dataset.started='1';pushHistory()}; inp.oninput=()=>{const p=photo();if(!p)return;const path=inp.dataset.edit,val=+inp.value;inp.nextElementSibling.value=inp.value;if(path==='curvesMid'){const y=clamp(.5+val/200,.02,.98);p.edits.curves.rgb=[[0,0],[.25,clamp(.25-val/500,0,1)],[.5,y],[.75,clamp(.75+val/500,0,1)],[1,1]];}else if(path.startsWith('mixer.')){const k=path.split('.')[1],c=state.mixerColor||'red';p.edits.color.mixer[c]=p.edits.color.mixer[c]||{};p.edits.color.mixer[c][k]=val;}else if(path.startsWith('mask.')){const m=p.edits.masks.find(x=>x.id===state.activeMask);if(!m)return;m.adjustments=m.adjustments||{};m.adjustments[path.split('.')[1]]=val;}else setPath(p.edits,path,val);savePhotoDebounced(p);renderPreview()};});
  $$('[data-rating]').forEach(s=>s.onclick=async()=>{const p=photo();p.rating=+s.dataset.rating;await patchMeta(p,{rating:p.rating});renderRightPanel();renderLibrary()});
  $$('[data-flag]').forEach(b=>b.onclick=async()=>{const p=photo();p.flag=b.dataset.flag;await patchMeta(p,{flag:p.flag});renderRightPanel();renderLibrary()});
  $$('[data-label]').forEach(b=>b.onclick=async()=>{const p=photo();p.colorLabel=b.dataset.label;await patchMeta(p,{colorLabel:p.colorLabel});renderRightPanel();renderLibrary()});
  $('#favBtn')?.addEventListener('click',async()=>{const p=photo();p.favorite=!p.favorite;await patchMeta(p,{favorite:p.favorite});renderRightPanel();renderLibrary()});
  $('#virtualCopyBtn')?.addEventListener('click',()=>toolAction('virtual-copy'));
  $('#profileSelect')?.addEventListener('change',e=>{const p=photo();pushHistory();p.edits.profile=p.edits.profile||{};p.edits.profile.name=e.target.value;p.edits.profile.adaptive=e.target.value==='Adaptive';savePhotoDebounced(p);renderPreview()}); if($('#profileSelect'))$('#profileSelect').value=photo()?.edits.profile?.name||'Adobe Color';
  $('#mixerColor')?.addEventListener('change',e=>{state.mixerColor=e.target.value.toLowerCase();renderRightPanel()});
  $('#pointColorBtn')?.addEventListener('click',()=>{const p=photo();const h=Number(prompt('Target hue (0–360)?',200));if(!Number.isFinite(h))return;const hueShift=Number(prompt('Hue shift degrees?',0)||0),satShift=Number(prompt('Saturation shift -100 to 100?',0)||0),lumShift=Number(prompt('Luminance shift -100 to 100?',0)||0),range=Number(prompt('Hue range width?',30)||30);pushHistory();p.edits.color.pointColors=p.edits.color.pointColors||[];p.edits.color.pointColors.push({h,range,hueShift,satShift,lumShift});savePhotoDebounced(p);renderPreview();toast('Point Color added')});
  $$('[data-curve]').forEach(b=>b.onclick=()=>{const p=photo();pushHistory();const type=b.dataset.curve;const map={linear:[[0,0],[1,1]],medium:[[0,0],[.25,.2],[.5,.5],[.75,.82],[1,1]],strong:[[0,0],[.2,.1],[.5,.5],[.8,.92],[1,1]],matte:[[0,.08],[.25,.22],[.5,.5],[.8,.82],[1,.95]]};p.edits.curves.rgb=map[type];savePhotoDebounced(p);renderPreview();toast(`${type} curve applied`)});
  $('#lensMake')?.addEventListener('change',e=>mutate('optics.lensMake',e.target.value));$('#lensModel')?.addEventListener('change',e=>mutate('optics.lensModel',e.target.value));
  $$('[data-select-mask]').forEach(c=>c.onclick=e=>{if(e.target.closest('button'))return;state.activeMask=c.dataset.selectMask;renderRightPanel();renderPreview()});

  $('#bwBtn')?.addEventListener('click',()=>mutate('color.bw',!photo().edits.color.bw));
  $('#autoColorBtn')?.addEventListener('click',()=>runAI('auto-light-color')); $('#autoLightBtn')?.addEventListener('click',()=>runAI('auto-light-color'));
  $$('[data-toggle]').forEach(b=>b.onclick=()=>{const p=photo();const path=b.dataset.toggle;mutate(path,!getPath(p.edits,path));renderRightPanel()});
  $('#rotateLeft')?.addEventListener('click',()=>{const e=photo().edits.crop;mutate('crop.rotate90',(e.rotate90-90)%360);renderRightPanel()});
  $('#rotateRight')?.addEventListener('click',()=>{const e=photo().edits.crop;mutate('crop.rotate90',(e.rotate90+90)%360);renderRightPanel()});
  $('#flipX')?.addEventListener('click',()=>{mutate('crop.flipX',!photo().edits.crop.flipX);renderRightPanel()});
  $('#flipY')?.addEventListener('click',()=>{mutate('crop.flipY',!photo().edits.crop.flipY);renderRightPanel()});
  $$('[data-upright]').forEach(b=>b.onclick=()=>{const p=photo();pushHistory();const t=b.dataset.upright;p.edits.geometry.upright=t;if(t==='level')p.edits.geometry.rotate=0;if(t==='vertical')Object.assign(p.edits.geometry,{vertical:0,horizontal:0});if(t==='full'||t==='auto')Object.assign(p.edits.geometry,{vertical:0,horizontal:0,rotate:0,aspect:0,scale:100,x:0,y:0});savePhotoDebounced(p);renderRightPanel();renderPreview()});
  $('#cropRatio')?.addEventListener('change',e=>{const p=photo();pushHistory();p.edits.crop.ratio=e.target.value;const map={'1:1':1,'4:3':4/3,'3:2':3/2,'16:9':16/9};if(map[e.target.value]){const r=map[e.target.value],ir=(p.meta.width||1)/(p.meta.height||1);if(ir>r){p.edits.crop.width=r/ir;p.edits.crop.height=1;p.edits.crop.x=(1-p.edits.crop.width)/2;p.edits.crop.y=0}else{p.edits.crop.width=1;p.edits.crop.height=ir/r;p.edits.crop.x=0;p.edits.crop.y=(1-p.edits.crop.height)/2}}else Object.assign(p.edits.crop,{x:0,y:0,width:1,height:1});savePhotoDebounced(p);renderPreview()});
  ['title','caption','copyright'].forEach(k=>{const el=$(`#${k}Input`);el?.addEventListener('change',async()=>{const p=photo();p[k]=el.value;await patchMeta(p,{[k]:el.value});renderLibrary()})});
  $('#keywordsInput')?.addEventListener('change',async e=>{const p=photo();p.keywords=e.target.value.split(',').map(x=>x.trim()).filter(Boolean);await patchMeta(p,{keywords:p.keywords})});
  $('#savePresetBtn')?.addEventListener('click',savePreset); $$('.preset-card').forEach(c=>c.onclick=()=>applyPreset(c.dataset.preset));
  $('#saveVersionBtn')?.addEventListener('click',saveVersion); $$('.version-card').forEach(c=>c.onclick=()=>restoreVersion(c.dataset.version));
  $$('[data-new-mask]').forEach(b=>b.onclick=()=>createMask(b.dataset.newMask));
  $$('[data-delete-mask]').forEach(b=>b.onclick=()=>deleteMask(b.dataset.deleteMask));
  $$('[data-invert-mask]').forEach(b=>b.onclick=()=>invertMask(b.dataset.invertMask));
  $$('.ai-mask,.ai-provider').forEach(b=>b.onclick=async()=>{const feature=b.dataset.aiFeature || ({subject:'subject-mask',sky:'sky-mask',background:'background-mask',people:'people-mask',object:'object-mask',landscape:'landscape-mask'}[b.dataset.ai]);if(feature==='generative-remove'){const maskDataUrl=retouchMaskDataUrl();if(!maskDataUrl)return toast('Add one or more retouch points first');return runAI(feature,{maskDataUrl,prompt:'remove the selected distraction and reconstruct the natural background'});}return runAI(feature);});
  const tools={healTool:'heal',cloneTool:'clone',contentAwareTool:'content-aware',redEyeTool:'red-eye'};for(const [id,t] of Object.entries(tools))$('#'+id)?.addEventListener('click',()=>{state.retouchTool=t;renderRightPanel();enableMaskPointer()});
  $('#retouchSize')?.addEventListener('input',e=>{state.retouchSize=+e.target.value;e.target.nextElementSibling.value=`${Math.round(state.retouchSize*1000)/10}%`});$('#clearRetouch')?.addEventListener('click',()=>{const p=photo();pushHistory();p.edits.retouch=[];p.edits.redEye=[];savePhotoDebounced(p);renderRightPanel();renderPreview()});
}
async function patchMeta(p,fields){try{await api(`/api/photos/${p.id}`,{method:'PATCH',body:JSON.stringify(fields)})}catch(e){toast(e.message)}}
async function savePreset(){const p=photo();const name=prompt('Preset name?','My Preset');if(!name)return;const x=await api('/api/presets',{method:'POST',body:JSON.stringify({name,edits:p.edits})});state.presets.unshift(x);renderRightPanel();toast('Preset saved')}
function applyPreset(id){const x=state.presets.find(p=>p.id===id),p=photo();if(!x||!p)return;pushHistory();p.edits=clone(x.edits);savePhotoDebounced(p);renderRightPanel();renderPreview();toast(`Applied ${x.name}`)}
async function saveVersion(){const p=photo();const name=prompt('Version name?',`Version ${(p.versions?.length||0)+1}`);if(!name)return;const v=await api(`/api/photos/${p.id}/versions`,{method:'POST',body:JSON.stringify({name})});p.versions.unshift(v);renderRightPanel();toast('Version created')}
async function restoreVersion(id){const p=photo();const restored=await api(`/api/photos/${p.id}/versions/${id}/restore`,{method:'POST',body:'{}'});p.edits=restored.edits;renderRightPanel();renderPreview();toast('Version restored')}
function createMask(type){const p=photo();pushHistory();const m={id:`mask_${Date.now()}`,type,name:type[0].toUpperCase()+type.slice(1),invert:false,feather:.2,adjustments:{exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0,temperature:0,tint:0,saturation:0,texture:0,clarity:0,dehaze:0,sharpness:0,noise:0}};if(type==='brush'){m.points=[];m.size=.04}if(type==='radial')Object.assign(m,{x:.5,y:.5,rx:.25,ry:.25});if(type==='linear')Object.assign(m,{x:.5,y:.5,angle:0,feather:.25});if(type==='luminance')Object.assign(m,{range:[.2,.8]});if(type==='color')Object.assign(m,{hue:Number(prompt('Target hue 0–360?',200)||200),range:Number(prompt('Hue range width?',30)||30)});p.edits.masks.push(m);state.activeMask=m.id;savePhotoDebounced(p);renderRightPanel();renderPreview();toast(type==='brush'?'Brush mask created — paint on the photo':'Mask created')}
function deleteMask(id){const p=photo();pushHistory();p.edits.masks=p.edits.masks.filter(m=>m.id!==id);savePhotoDebounced(p);renderRightPanel();renderPreview()}
function invertMask(id){const p=photo();const m=p.edits.masks.find(x=>x.id===id);if(!m)return;pushHistory();m.invert=!m.invert;savePhotoDebounced(p);renderRightPanel();renderPreview()}

// Paint points into the active brush mask.
let painting=false;
overlay.style.pointerEvents='none';
function enableMaskPointer(){overlay.style.pointerEvents=(state.panel==='mask'||state.panel==='retouch')?'auto':'none'}
overlay.addEventListener('pointerdown',e=>{const p=photo();if(!p)return;if(state.panel==='retouch'){const r=overlay.getBoundingClientRect(),x=clamp((e.clientX-r.left)/r.width,0,1),y=clamp((e.clientY-r.top)/r.height,0,1),size=state.retouchSize||.035;pushHistory();if(state.retouchTool==='red-eye'){p.edits.redEye=p.edits.redEye||[];p.edits.redEye.push({x,y,size});}else{p.edits.retouch=p.edits.retouch||[];p.edits.retouch.push({type:state.retouchTool||'heal',x,y,size,sourceX:clamp(x-.1,0,1),sourceY:clamp(y-.1,0,1)});}savePhotoDebounced(p);renderRightPanel();renderPreview();return;}const m=p.edits.masks.find(x=>x.id===state.activeMask&&x.type==='brush');if(!m)return;painting=true;pushHistory();addBrushPoint(e,m);overlay.setPointerCapture(e.pointerId)});
overlay.addEventListener('pointermove',e=>{if(!painting)return;const m=photo()?.edits.masks.find(x=>x.id===state.activeMask);if(m)addBrushPoint(e,m)});
overlay.addEventListener('pointerup',()=>{painting=false;const p=photo();if(p)savePhotoDebounced(p)});
function addBrushPoint(e,m){const r=overlay.getBoundingClientRect();m.points.push({x:clamp((e.clientX-r.left)/r.width,0,1),y:clamp((e.clientY-r.top)/r.height,0,1)});renderPreview()}
function retouchMaskDataUrl(){const p=photo();if(!p||(p.edits.retouch||[]).length===0)return null;const c=document.createElement('canvas');c.width=Math.max(512,editCanvas.width);c.height=Math.max(512,editCanvas.height);const x=c.getContext('2d');x.fillStyle='black';x.fillRect(0,0,c.width,c.height);x.fillStyle='white';for(const op of p.edits.retouch||[]){x.beginPath();x.arc(op.x*c.width,op.y*c.height,(op.size||.03)*Math.min(c.width,c.height),0,Math.PI*2);x.fill()}return c.toDataURL('image/png')}


$('#fileInput').onchange=e=>{uploadFiles(e.target.files);e.target.value=''}; $$('.fileInputMirror').forEach(i=>i.onchange=e=>uploadFiles(e.target.files));
$$('.tab').forEach(t=>t.onclick=()=>setWorkspace(t.dataset.workspace));
$$('[data-view]').forEach(b=>b.onclick=async()=>{state.view=b.dataset.view;state.currentAlbum=null;if(state.view==='trash')state.trashPhotos=await api('/api/trash');$$('[data-view]').forEach(x=>x.classList.toggle('active',x===b));renderAlbums();renderLibrary()});
$('#searchInput').oninput=renderLibrary;$('#ratingFilter').onchange=renderLibrary;$('#sortSelect').onchange=renderLibrary;$('#gridSize').oninput=e=>document.documentElement.style.setProperty('--thumb',e.target.value+'px');
$('#newAlbumBtn').onclick=async()=>{const name=prompt('Album name?','New Album');if(!name)return;const a=await api('/api/albums',{method:'POST',body:JSON.stringify({name})});state.albums.push(a);renderAlbums()};
$('#presetsNav').onclick=()=>{state.panel='presets';setWorkspace('edit');state.panel='presets';renderRightPanel()};$('#versionsNav').onclick=()=>{state.panel='versions';setWorkspace('edit');state.panel='versions';renderRightPanel()};$('#metadataNav').onclick=()=>{state.panel='metadata';setWorkspace('edit');state.panel='metadata';renderRightPanel()};
$('#undoBtn').onclick=undo;$('#redoBtn').onclick=redo;$('#beforeAfterBtn').onclick=()=>{state.before=!state.before;$('#beforeAfterBtn').classList.toggle('active',state.before);renderPreview()};$('#fitBtn').onclick=()=>{state.zoom='fit';renderPreview()};$('#oneToOneBtn').onclick=()=>{state.zoom='100';renderPreview()};
$('#resetBtn').onclick=()=>{const p=photo();if(!p)return;if(!confirm('Reset all edits on this photo?'))return;pushHistory();p.edits=defaults();savePhotoDebounced(p);renderRightPanel();renderPreview()};
$('#exportBtn').onclick=()=>{if(!photo())return toast('Select a photo first');$('#exportModal').classList.add('open')};$$('.close-modal').forEach(b=>b.onclick=()=>$('#exportModal').classList.remove('open'));$('#exportQuality').oninput=e=>$('#qualityValue').textContent=e.target.value;
$('#doExportBtn').onclick=async()=>{const p=photo();if(!p)return;const btn=$('#doExportBtn');btn.disabled=true;btn.textContent='Rendering…';try{const x=await api(`/api/photos/${p.id}/export`,{method:'POST',body:JSON.stringify({format:$('#exportFormat').value,quality:+$('#exportQuality').value,maxSize:+$('#exportSize').value,colorSpace:$('#exportColorSpace').value,outputSharpening:$('#exportSharpen').value,sharpenAmount:$('#exportSharpenAmount').value,dpi:+$('#exportDpi').value,watermarkText:$('#exportWatermark').value,watermarkOpacity:70,watermarkPosition:'bottom-right',includeMetadata:$('#exportMetadata').value!=='none',removeLocation:$('#exportMetadata').value==='no-location',contentCredentials:$('#exportCredentials').checked})});const a=document.createElement('a');a.href=x.url;a.download=x.filename;document.body.append(a);a.click();a.remove();$('#exportModal').classList.remove('open');toast('Export ready')}catch(e){toast(e.message)}finally{btn.disabled=false;btn.textContent='Export file'}};

const stage=$('#canvasStage');['dragenter','dragover'].forEach(ev=>stage.addEventListener(ev,e=>{e.preventDefault();stage.classList.add('dragging')}));['dragleave','drop'].forEach(ev=>stage.addEventListener(ev,e=>{e.preventDefault();stage.classList.remove('dragging')}));stage.addEventListener('drop',e=>uploadFiles(e.dataTransfer.files));
window.addEventListener('resize',()=>{if(state.workspace!=='library')renderPreview()});
window.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();e.shiftKey?redo():undo()}if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();redo()}if(e.key==='g'&&!e.ctrlKey&&!e.metaKey)setWorkspace('library');if(e.key==='e'&&!e.ctrlKey&&!e.metaKey)setWorkspace('edit')});
const observer=new MutationObserver(enableMaskPointer);observer.observe($('#rightPanelContent'),{childList:true});


function selectionIds(){return [...state.selectedIds].filter(id=>state.photos.some(p=>p.id===id));}
async function refreshHQPreview(p){
  if(!p||p.id!==state.selectedId||state.before||state.panel!=='edit')return;
  const marker=JSON.stringify(p.edits); const img=new Image(); img.crossOrigin='anonymous';
  img.onload=()=>{if(p.id!==state.selectedId||marker!==JSON.stringify(p.edits)||state.panel!=='edit')return;const {w,h}=computeTargetSize(img);editCanvas.width=w;editCanvas.height=h;overlay.width=w;overlay.height=h;editCanvas.style.transform='none';overlay.style.transform='none';ctx.clearRect(0,0,w,h);ctx.drawImage(img,0,0,w,h);const data=ctx.getImageData(0,0,w,h);updateHistogram(data);};
  img.src=`/api/photos/${p.id}/render?max=2200&v=${Date.now()}`;
}
async function maskUrlToBrush(url,name){
  const p=photo();if(!p)return;const img=new Image();img.crossOrigin='anonymous';await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=reject;img.src=url+'?v='+Date.now()});
  const c=document.createElement('canvas');c.width=80;c.height=80;const cc=c.getContext('2d');cc.drawImage(img,0,0,80,80);const d=cc.getImageData(0,0,80,80).data,pts=[];
  for(let y=0;y<80;y+=2)for(let x=0;x<80;x+=2){const i=(y*80+x)*4;if(d[i]>110)pts.push({x:(x+.5)/80,y:(y+.5)/80});}
  pushHistory();const m={id:`mask_${Date.now()}`,type:'brush',name,points:pts,size:.018,invert:false,adjustments:{exposure:0,contrast:0,highlights:0,shadows:0,whites:0,blacks:0,temperature:0,tint:0,saturation:0,texture:0,clarity:0,dehaze:0,sharpness:0,noise:0}};p.edits.masks.push(m);state.activeMask=m.id;savePhotoDebounced(p);setWorkspace('mask');renderRightPanel();renderPreview();
}
async function runAI(feature,extra={}){
  const p=photo();if(!p&&feature!=='assisted-culling')return toast('Select a photo first');
  document.body.classList.add('processing');toast(`${feature.replaceAll('-',' ')} processing…`);
  try{
    if(feature==='object-mask'&&!extra.prompt)extra.prompt=prompt('Object to select?','person')||'';
    const r=await api('/api/ai/run',{method:'POST',body:JSON.stringify({feature,photoId:p?.id,ids:selectionIds(),...extra})});
    if(feature.endsWith('-mask')&&r.url){await maskUrlToBrush(r.url,feature.replace('-mask','').replaceAll('-',' '));toast('AI mask added');return r;}
    if(feature==='auto-light-color'&&p){pushHistory();Object.assign(p.edits.light,r.light||{});Object.assign(p.edits.color,r.color||{});savePhotoDebounced(p);renderRightPanel();renderPreview();toast('Auto Light & Color applied');return r;}
    if(feature==='recommended-presets'&&r.presets){for(const pr of r.presets){const x=await api('/api/presets',{method:'POST',body:JSON.stringify({name:pr.name,edits:{...defaults(),...pr.edits}})});state.presets.unshift(x)}toast(`${r.presets.length} recommended presets saved`);return r;}
    if((feature==='adaptive-presets'||feature==='adaptive-profiles')&&p){const edits=r.preset?.edits||r.profile?.edits;if(edits){pushHistory();if(edits.light)Object.assign(p.edits.light,edits.light);if(edits.color)Object.assign(p.edits.color,edits.color);if(feature==='adaptive-profiles')p.edits.profile={name:'Adaptive',amount:100,adaptive:true};savePhotoDebounced(p);renderRightPanel();renderPreview();}toast(`${feature.replaceAll('-',' ')} applied`);return r;}
    if(feature==='assisted-culling'&&r.items){for(const item of r.items){const ph=state.photos.find(x=>item.path?.includes(x.originalPath));if(ph&&item.recommendation!=='review'){ph.flag=item.recommendation==='select'?'pick':'reject';await patchMeta(ph,{flag:ph.flag})}}renderLibrary();alert(r.items.map(x=>`${x.recommendation.toUpperCase()}  score ${x.score}  sharp ${x.sharpness}`).join('\n'));return r;}
    if(r.generatedPhoto){state.photos.unshift(r.generatedPhoto);state.selectedId=r.generatedPhoto.id;state.selectedIds=new Set([r.generatedPhoto.id]);renderLibrary();renderFilmstrip();await loadSelectedImage();setWorkspace('edit');toast('Enhanced copy added to library');return r;}
    toast(`${feature.replaceAll('-',' ')} completed`);return r;
  }catch(e){toast(e.message);throw e}finally{document.body.classList.remove('processing')}
}

async function toolAction(action){
  const ids=selectionIds(),p=photo();
  try{
    if(action==='hdr'||action==='panorama'){if(ids.length<2)return toast('Ctrl/Cmd-click at least 2 photos');const x=await api(`/api/merge/${action}`,{method:'POST',body:JSON.stringify({ids})});state.photos.unshift(x);state.selectedId=x.id;state.selectedIds=new Set([x.id]);renderLibrary();renderFilmstrip();await loadSelectedImage();setWorkspace('edit');toast(`${action} created`);}
    if(action==='hdr-panorama'){if(ids.length<4)return toast('Select bracketed photos first');const n=Number(prompt('How many exposures per bracket?',3)||3);const groups=[];for(let i=0;i<ids.length;i+=n)groups.push(ids.slice(i,i+n));const x=await api('/api/merge/hdr-panorama',{method:'POST',body:JSON.stringify({groups})});state.photos.unshift(x);state.selectedId=x.id;state.selectedIds=new Set([x.id]);renderLibrary();renderFilmstrip();await loadSelectedImage();setWorkspace('edit');}
    if(action==='virtual-copy'&&p){const x=await api(`/api/photos/${p.id}/virtual-copy`,{method:'POST',body:'{}'});state.photos.unshift(x);renderLibrary();renderFilmstrip();toast('Virtual copy created');}
    if(action==='auto-stack'){const seconds=Number(prompt('Auto-stack photos captured within how many seconds?',10)||10);await api('/api/photos/auto-stack',{method:'POST',body:JSON.stringify({ids,seconds})});toast('Stacking updated');}
    if(action==='smart-album'){const name=prompt('Smart Album name?','5-star Picks');if(!name)return;const rating=Number(prompt('Minimum rating?',4)||4);const x=await api('/api/smart-albums',{method:'POST',body:JSON.stringify({name,match:'all',rules:[{field:'rating',op:'gte',value:rating}]})});state.smartAlbums=state.smartAlbums||[];state.smartAlbums.push(x);renderAlbums();toast('Smart Album created');}
    if(action==='catalog-export'){const x=await api('/api/catalog/export',{method:'POST',body:JSON.stringify({includeOriginals:confirm('Include original files in the catalog archive?'),includePreviews:true})});location.href=x.url;}
    if(action==='publish'){const name=prompt('Publish collection name?','Published');if(!name)return;await api('/api/publish',{method:'POST',body:JSON.stringify({name,ids})});toast('Published to persistent disk');}
    if(action==='web-gallery'){const title=prompt('Gallery title?','Lumina Gallery')||'Lumina Gallery';const x=await api('/api/galleries',{method:'POST',body:JSON.stringify({title,ids})});window.open(x.url,'_blank');}
    if(action==='slideshow'){const duration=Number(prompt('Seconds per slide?',3)||3);const x=await api('/api/slideshows',{method:'POST',body:JSON.stringify({name:'Slideshow',ids,duration,crossfade:1})});location.href=x.url;}
    if(action==='book'){const title=prompt('Book title?','Photo Book')||'Photo Book';const x=await api('/api/books',{method:'POST',body:JSON.stringify({title,ids,pageSize:'letter'})});location.href=x.url;}
    if(action==='print'){const x=await api('/api/print',{method:'POST',body:JSON.stringify({ids,columns:3,rows:4,border:8})});location.href=x.url;}
    if(action==='tether'){const x=await api('/api/tether/capture',{method:'POST',body:'{}'});state.photos.unshift(x);state.selectedId=x.id;state.selectedIds=new Set([x.id]);renderLibrary();renderFilmstrip();await loadSelectedImage();toast('Tethered photo captured');}
    if(action==='camera')openCamera();
    if(action==='video-export'){if(!p||p.meta?.kind!=='video')return toast('Select a video');const x=await api(`/api/video/${p.id}/export`,{method:'POST',body:JSON.stringify({edits:p.edits,crf:18})});location.href=x.url;}
    if(action==='share'){let album=state.currentAlbum&&state.view==='album'?state.albums.find(a=>a.id===state.currentAlbum):null;if(!album){album=await api('/api/albums',{method:'POST',body:JSON.stringify({name:'Shared Selection'})});album.photoIds=ids;await api(`/api/albums/${album.id}`,{method:'PATCH',body:JSON.stringify({photoIds:ids})});state.albums.push(album);renderAlbums()}const sh=await api(`/api/share/album/${album.id}`,{method:'POST',body:JSON.stringify({allowDownload:true,allowContribute:confirm('Allow other people to contribute photos?'),allowEdit:confirm('Allow collaborative editing?')})});const url=new URL(sh.url,location.origin).href;await navigator.clipboard?.writeText(url).catch(()=>{});prompt('Share link (copied if browser permission allowed):',url);}
    if(action==='community-publish'&&p){const x=await api('/api/community',{method:'POST',body:JSON.stringify({photoId:p.id,author:'Local Creator',caption:p.caption})});toast(`Published edit ${x.id}`);}
    if(action==='discover'){const feed=await api('/api/community');if(!feed.length)return toast('Discover feed is empty');const choice=prompt(feed.map((x,i)=>`${i+1}. ${x.name} — ${x.author} — ♥${x.likes||0}`).join('\n')+'\n\nEnter a number to remix onto the selected photo:','1');const post=feed[Number(choice)-1];if(post&&p){const x=await api(`/api/community/${post.id}/remix`,{method:'POST',body:JSON.stringify({photoId:p.id})});p.edits=x.edits;renderRightPanel();renderPreview();toast('Remix applied')}}
    if(action==='tutorials'){const t=await api('/api/tutorials');alert(t.map(x=>`${x.title}\n• ${x.steps.join('\n• ')}`).join('\n\n'));}
    if(action==='external-copy'&&p){const x=await api(`/api/photos/${p.id}/external-copy`,{method:'POST',body:'{}'});location.href=x.url;toast('TIFF handoff created — edit it externally, then import the result');}
    if(action==='plugins'&&p){const list=await api('/api/plugins');if(!list.length)return toast('No plug-ins installed in /var/data/plugins');const pick=prompt(list.map((x,i)=>`${i+1}. ${x.name||x.folder}`).join('\n'),'1');const plug=list[Number(pick)-1];if(!plug)return;const x=await api(`/api/plugins/${plug.folder}/run`,{method:'POST',body:JSON.stringify({photoId:p.id,options:{}})});if(x.generatedPhoto){state.photos.unshift(x.generatedPhoto);state.selectedId=x.generatedPhoto.id;state.selectedIds=new Set([x.generatedPhoto.id]);renderLibrary();renderFilmstrip();await loadSelectedImage()}toast('Plug-in finished');}

  }catch(e){toast(e.message)}
}

let cameraStream=null,cameraFacing='environment';
async function openCamera(){try{cameraStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:cameraFacing},audio:false});$('#cameraVideo').srcObject=cameraStream;$('#cameraModal').classList.add('open')}catch(e){toast(e.message)}}
function closeCamera(){cameraStream?.getTracks().forEach(t=>t.stop());cameraStream=null;$('#cameraModal').classList.remove('open')}
$('#advancedBtn').onclick=()=>$('#advancedModal').classList.add('open');$$('.close-advanced').forEach(b=>b.onclick=()=>$('#advancedModal').classList.remove('open'));$$('.tool-action[data-action]').forEach(b=>b.onclick=()=>toolAction(b.dataset.action));$$('[data-ai-action]').forEach(b=>b.onclick=()=>runAI(b.dataset.aiAction));
$$('.close-camera').forEach(b=>b.onclick=closeCamera);$('#switchCameraBtn').onclick=async()=>{cameraFacing=cameraFacing==='environment'?'user':'environment';closeCamera();await openCamera()};
$('#captureCameraBtn').onclick=async()=>{const v=$('#cameraVideo'),c=$('#cameraCapture');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',.96));const fd=new FormData();fd.append('photos',blob,`camera-${Date.now()}.jpg`);const data=await api('/api/photos',{method:'POST',body:fd});const x=data.items.find(i=>!i.error);if(x){state.photos.unshift(x);state.selectedId=x.id;state.selectedIds=new Set([x.id]);renderLibrary();renderFilmstrip();await loadSelectedImage();}closeCamera();toast('Camera photo imported')};
$('#gpxInput').onchange=async e=>{const f=e.target.files[0];if(!f)return;const fd=new FormData();fd.append('gpx',f);try{const x=await api('/api/map/gpx',{method:'POST',body:fd});toast(`GPX matched ${x.matched} photos`)}catch(err){toast(err.message)}e.target.value=''};


let syncTimer=null;try{const events=new EventSource('/api/events');events.onmessage=()=>{clearTimeout(syncTimer);syncTimer=setTimeout(async()=>{try{const d=await api('/api/state');const current=photo();state.photos=d.photos||state.photos;state.albums=d.albums||state.albums;state.presets=d.presets||state.presets;state.smartAlbums=d.smartAlbums||state.smartAlbums;if(current){const fresh=state.photos.find(x=>x.id===current.id);if(fresh&&fresh.modifiedAt!==current.modifiedAt){state.selectedId=fresh.id;await loadSelectedImage();renderRightPanel()}}renderLibrary();renderAlbums();renderFilmstrip()}catch{}},900)}}catch{}

if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
boot();
