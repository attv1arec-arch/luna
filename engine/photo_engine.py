#!/usr/bin/env python3
import argparse, json, math, os, subprocess, sys, tempfile, shutil, zipfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, ImageEnhance, ImageFilter, ImageDraw, ImageChops, ImageCms

try:
    import cv2
except Exception:
    cv2 = None
try:
    import rawpy
except Exception:
    rawpy = None
try:
    from scipy.interpolate import PchipInterpolator
except Exception:
    PchipInterpolator = None
try:
    from skimage import exposure as sk_exposure
except Exception:
    sk_exposure = None

RAW_EXTS={'.cr2','.cr3','.nef','.arw','.dng','.raf','.rw2','.orf','.pef','.srw','.3fr','.fff','.iiq'}

def clamp(v,a=0,b=1): return max(a,min(b,v))
def jload(p,default=None):
    if not p: return default if default is not None else {}
    with open(p,'r',encoding='utf-8') as f: return json.load(f)
def jsave(p,o):
    Path(p).parent.mkdir(parents=True,exist_ok=True)
    with open(p,'w',encoding='utf-8') as f: json.dump(o,f,indent=2)

def load_image(path, max_dim=0):
    ext=Path(path).suffix.lower()
    if ext in RAW_EXTS and rawpy:
        with rawpy.imread(path) as raw:
            rgb=raw.postprocess(use_camera_wb=True, no_auto_bright=True, output_bps=16, gamma=(1,1))
        arr=(rgb.astype(np.float32)/65535.0)
    else:
        im=Image.open(path)
        im=ImageOps.exif_transpose(im).convert('RGB')
        if max_dim and max(im.size)>max_dim:
            im.thumbnail((max_dim,max_dim),Image.Resampling.LANCZOS)
        arr=np.asarray(im).astype(np.float32)/255.0
    return np.clip(arr,0,1)

def save_image(arr,path,opts=None):
    opts=opts or {}; arr=np.clip(arr,0,1)
    im=Image.fromarray((arr*255+0.5).astype(np.uint8),'RGB')
    max_size=int(opts.get('maxSize') or 0)
    if max_size and max(im.size)>max_size: im.thumbnail((max_size,max_size),Image.Resampling.LANCZOS)
    if opts.get('outputSharpening') and opts.get('outputSharpening')!='none':
        radius={'low':.6,'standard':1.0,'high':1.5}.get(str(opts.get('sharpenAmount','standard')),1.0);im=im.filter(ImageFilter.UnsharpMask(radius=radius,percent={'low':70,'standard':110,'high':160}.get(str(opts.get('sharpenAmount','standard')),110),threshold=2))
    wt=str(opts.get('watermarkText') or '')
    if wt:
        from PIL import ImageFont
        layer=Image.new('RGBA',im.size,(0,0,0,0));d=ImageDraw.Draw(layer);font=ImageFont.load_default();bbox=d.textbbox((0,0),wt,font=font);tw,th=bbox[2]-bbox[0],bbox[3]-bbox[1];pad=max(10,int(min(im.size)*.015));pos=str(opts.get('watermarkPosition','bottom-right'));xy={'top-left':(pad,pad),'top-right':(im.width-tw-pad,pad),'bottom-left':(pad,im.height-th-pad),'bottom-right':(im.width-tw-pad,im.height-th-pad),'center':((im.width-tw)//2,(im.height-th)//2)}.get(pos,(im.width-tw-pad,im.height-th-pad));opacity=int(clamp(float(opts.get('watermarkOpacity',70))/100)*255);d.text(xy,wt,font=font,fill=(255,255,255,opacity),stroke_width=1,stroke_fill=(0,0,0,opacity));im=Image.alpha_composite(im.convert('RGBA'),layer).convert('RGB')
    p=Path(path); p.parent.mkdir(parents=True,exist_ok=True)
    ext=p.suffix.lower(); q=int(opts.get('quality') or 92)
    kwargs={}
    if ext in ('.jpg','.jpeg'): kwargs={'quality':q,'optimize':True,'subsampling':0}
    elif ext=='.webp': kwargs={'quality':q,'method':6}
    elif ext=='.png': kwargs={'optimize':True}
    elif ext in ('.tif','.tiff'): kwargs={'compression':'tiff_lzw'}
    elif ext=='.avif': kwargs={'quality':q}
    if opts.get('dpi'): kwargs['dpi']=(int(opts['dpi']),int(opts['dpi']))
    im.save(path, **kwargs)

def srgb_to_linear(x): return np.where(x<=0.04045,x/12.92,((x+0.055)/1.055)**2.4)
def linear_to_srgb(x): return np.where(x<=0.0031308,12.92*x,1.055*np.power(np.clip(x,0,None),1/2.4)-0.055)
def luma(a): return a[...,0]*0.2126+a[...,1]*0.7152+a[...,2]*0.0722


def apply_profile(arr,profile):
    p=profile or {}; name=str(p.get('name','Adobe Color')); amount=float(p.get('amount',100))/100; base=arr.copy(); out=arr.copy()
    if name=='Adobe Neutral': out=np.clip((out-.5)*.88+.5,0,1)
    elif name=='Adobe Vivid':
        h=rgb_to_hsv_np(out);h[...,1]=np.clip(h[...,1]*1.22,0,1);out=hsv_to_rgb_np(h);out=np.clip((out-.5)*1.08+.5,0,1)
    elif name=='Adobe Portrait': out=apply_temp_tint(out,5,2); out=np.clip((out-.5)*.94+.5,0,1)
    elif name=='Adobe Landscape':
        h=rgb_to_hsv_np(out);h[...,1]=np.clip(h[...,1]*1.15,0,1);out=hsv_to_rgb_np(h);out=np.clip(out+highpass(out,3)*.18,0,1)
    elif name=='Monochrome':
        y=luma(out);out=np.repeat(y[...,None],3,axis=2)
    return np.clip(base*(1-amount)+out*amount,0,1)

def apply_calibration(arr,c):
    if not c:return arr
    out=arr.copy(); st=float(c.get('shadowTint',0))/100
    y=luma(out); sm=(1-np.clip(y/.45,0,1))[...,None]; out=np.clip(out+sm*np.array([st*.03,-abs(st)*.015,-st*.03],np.float32),0,1)
    hsv=rgb_to_hsv_np(out)
    prim=[(0,c.get('redHue',0),c.get('redSat',0)),(120,c.get('greenHue',0),c.get('greenSat',0)),(240,c.get('blueHue',0),c.get('blueSat',0))]
    for ctr,hs,ss in prim:
        d=np.abs((hsv[...,0]-ctr+180)%360-180);m=np.clip(1-d/75,0,1);hsv[...,0]=(hsv[...,0]+m*float(hs)*.25)%360;hsv[...,1]=np.clip(hsv[...,1]*(1+m*float(ss)/100),0,1)
    return hsv_to_rgb_np(hsv)

def apply_exposure(arr, stops): return np.clip(arr*(2.0**float(stops)),0,1)

def tone_regions(arr,e):
    y=luma(arr); out=arr.copy()
    h=float(e.get('highlights',0))/100; s=float(e.get('shadows',0))/100; w=float(e.get('whites',0))/100; b=float(e.get('blacks',0))/100
    # smooth masks approximate Lightroom tonal regions
    sh=(1-np.clip(y/0.55,0,1))**1.7; hi=np.clip((y-0.35)/0.65,0,1)**1.7
    wh=np.clip((y-0.72)/0.28,0,1)**1.4; bl=(1-np.clip(y/0.28,0,1))**1.5
    delta=(s*0.28*sh + h*0.22*hi + w*0.18*wh + b*0.16*bl)[...,None]
    out=np.clip(out+delta,0,1)
    c=float(e.get('contrast',0))/100
    if c:
        pivot=0.5; gain=1+c*0.9
        out=np.clip((out-pivot)*gain+pivot,0,1)
    return out

def apply_temp_tint(arr,temp,tint):
    t=float(temp)/100; m=float(tint)/100
    gains=np.array([1+t*0.16+m*0.04,1-abs(m)*0.05,1-t*0.16+m*0.04],dtype=np.float32)
    return np.clip(arr*gains,0,1)

def rgb_to_hsv_np(rgb):
    if cv2 is not None:
        return cv2.cvtColor(rgb.astype(np.float32),cv2.COLOR_RGB2HSV)
    im=Image.fromarray((np.clip(rgb,0,1)*255).astype(np.uint8),'RGB').convert('HSV')
    a=np.asarray(im).astype(np.float32); a[...,0]*=360/255; a[...,1:]/=255; return a

def hsv_to_rgb_np(hsv):
    if cv2 is not None:
        return np.clip(cv2.cvtColor(hsv.astype(np.float32),cv2.COLOR_HSV2RGB),0,1)
    a=hsv.copy(); a[...,0]=np.mod(a[...,0],360)*255/360; a[...,1:]=np.clip(a[...,1:],0,1)*255
    return np.asarray(Image.fromarray(a.astype(np.uint8),'HSV').convert('RGB')).astype(np.float32)/255

def apply_color(arr,color):
    hsv=rgb_to_hsv_np(arr); sat=float(color.get('saturation',0))/100; vib=float(color.get('vibrance',0))/100
    hsv[...,1]=np.clip(hsv[...,1]*(1+sat) + vib*(1-hsv[...,1])*0.45,0,1)
    mixer=color.get('mixer') or {}
    centers={'red':0,'orange':30,'yellow':60,'green':120,'aqua':180,'blue':240,'purple':285,'magenta':325}
    for name,ctr in centers.items():
        cfg=mixer.get(name) or {}
        if not cfg: continue
        d=np.abs((hsv[...,0]-ctr+180)%360-180); mask=np.clip(1-d/40,0,1)
        hsv[...,0]=(hsv[...,0]+mask*float(cfg.get('hue',0))*0.45)%360
        hsv[...,1]=np.clip(hsv[...,1]*(1+mask*float(cfg.get('saturation',0))/100),0,1)
        lum=float(cfg.get('luminance',0))/100
        if lum: arr=np.clip(arr + mask[...,None]*lum*0.22,0,1)
    arr=hsv_to_rgb_np(hsv)
    # point-color samples
    for pc in color.get('pointColors') or []:
        target=float(pc.get('h',0)); radius=max(1,float(pc.get('range',20))); d=np.abs((hsv[...,0]-target+180)%360-180); mask=np.clip(1-d/radius,0,1)
        h2=rgb_to_hsv_np(arr); h2[...,0]=(h2[...,0]+mask*float(pc.get('hueShift',0)))%360
        h2[...,1]=np.clip(h2[...,1]*(1+mask*float(pc.get('satShift',0))/100),0,1); arr=hsv_to_rgb_np(h2)
        arr=np.clip(arr+mask[...,None]*float(pc.get('lumShift',0))/100*0.2,0,1)
    if color.get('bw'):
        y=luma(arr); arr=np.repeat(y[...,None],3,axis=2)
    return arr

def curve_lut(points):
    pts=sorted(points or [[0,0],[1,1]],key=lambda p:p[0]); x=np.array([p[0] for p in pts],float); y=np.array([p[1] for p in pts],float)
    xx=np.linspace(0,1,4096)
    if PchipInterpolator is not None and len(pts)>2: yy=PchipInterpolator(x,y)(xx)
    else: yy=np.interp(xx,x,y)
    return np.clip(yy,0,1)

def apply_curves(arr,curves):
    out=arr.copy(); master=curve_lut(curves.get('rgb')); idx=np.minimum(4095,(out*4095).astype(int)); out=master[idx]
    for ci,key in enumerate(('red','green','blue')):
        lut=curve_lut(curves.get(key)); idx=np.minimum(4095,(out[...,ci]*4095).astype(int)); out[...,ci]=lut[idx]
    return np.clip(out,0,1)

def hue_color(h,s):
    hsv=np.array([[[float(h)%360, clamp(float(s)/100),1.0]]],dtype=np.float32)
    return hsv_to_rgb_np(hsv)[0,0]

def apply_grading(arr,g):
    y=luma(arr); out=arr.copy(); balance=float(g.get('balance',0))/100; blend=float(g.get('blending',50))/100
    sm=np.clip((0.55+balance*0.2-y)/0.55,0,1); hm=np.clip((y-(0.45+balance*0.2))/0.55,0,1); mm=np.clip(1-np.abs(y-0.5)*2,0,1)
    for key,mask in [('shadows',sm),('mids',mm),('highlights',hm),('global',np.ones_like(y))]:
        c=g.get(key) or {}; sat=float(c.get('s',0))/100
        if sat<=0: continue
        col=hue_color(c.get('h',0),c.get('s',0)); wgt=mask[...,None]*sat*(0.12+0.28*blend)
        out=np.clip(out*(1-wgt)+col*wgt,0,1)
        if c.get('l'): out=np.clip(out+mask[...,None]*float(c.get('l',0))/100*0.12,0,1)
    return out

def highpass(arr,sigma=2):
    if cv2 is not None:
        blur=cv2.GaussianBlur(arr,(0,0),sigmaX=sigma); return arr-blur
    im=Image.fromarray((arr*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma)); return arr-np.asarray(im).astype(np.float32)/255

def apply_effects(arr,e):
    out=arr.copy(); tex=float(e.get('texture',0))/100; clarity=float(e.get('clarity',0))/100; deh=float(e.get('dehaze',0))/100
    if tex: out=np.clip(out+highpass(out,1.0)*tex*0.7,0,1)
    if clarity: out=np.clip(out+highpass(out,4.0)*clarity*1.1,0,1)
    if deh:
        y=luma(out); black=np.percentile(y,2); out=np.clip((out-black*deh*0.7)/(1-black*deh*0.7+1e-6),0,1); out=np.clip((out-0.5)*(1+deh*0.35)+0.5,0,1)
    h,w=out.shape[:2]; vig=float(e.get('vignette',0))/100
    if vig:
        yy,xx=np.mgrid[0:h,0:w]; nx=(xx-w/2)/(w/2); ny=(yy-h/2)/(h/2); r=np.sqrt(nx*nx+ny*ny); mask=np.clip((r-0.25)/0.85,0,1)**1.6
        out=np.clip(out*(1+vig*0.55*mask[...,None]),0,1)
    grain=float(e.get('grain',0))/100
    if grain:
        rng=np.random.default_rng(1337); noise=rng.normal(0,0.045*grain,size=out.shape[:2]).astype(np.float32)
        out=np.clip(out+noise[...,None],0,1)
    return out

def apply_detail(arr,d):
    out=arr.copy(); lnr=float(d.get('luminanceNR',0)); cnr=float(d.get('colorNR',0)); sharp=float(d.get('sharpen',0)); radius=max(.2,float(d.get('radius',1)))
    if cv2 is not None and (lnr>0 or cnr>0):
        u8=(out*255).astype(np.uint8); out=cv2.fastNlMeansDenoisingColored(u8,None,max(0,lnr*.14),max(0,cnr*.14),7,21).astype(np.float32)/255
    if sharp>0:
        hp=highpass(out,radius); amount=sharp/100*1.6; masking=float(d.get('masking',0))/100
        if masking:
            gy,gx=np.gradient(luma(out)); edge=np.clip(np.sqrt(gx*gx+gy*gy)*8,0,1); edge=np.clip((edge-masking*.45)/(1-masking*.45+1e-6),0,1)
            hp*=edge[...,None]
        out=np.clip(out+hp*amount,0,1)
    return out

def apply_optics(arr,o):
    if cv2 is None: return arr
    h,w=arr.shape[:2]; dist=float(o.get('distortion',0))/100
    if abs(dist)>1e-4:
        k=dist*0.35; K=np.array([[w,0,w/2],[0,w,h/2],[0,0,1]],dtype=np.float32); D=np.array([k,0,0,0,0],dtype=np.float32)
        arr=cv2.undistort(arr,K,D)
    if o.get('chromaticAberration'):
        # align red/blue channels to green by small phase correlation where possible
        try:
            g=arr[...,1]; out=arr.copy()
            for ci in (0,2):
                shift,_=cv2.phaseCorrelate(arr[...,ci].astype(np.float32),g.astype(np.float32)); M=np.float32([[1,0,shift[0]*.15],[0,1,shift[1]*.15]])
                out[...,ci]=cv2.warpAffine(arr[...,ci],M,(w,h),borderMode=cv2.BORDER_REFLECT)
            arr=out
        except Exception: pass
    # simple defringe suppression
    hsv=rgb_to_hsv_np(arr)
    for hue,amount in [(285,float(o.get('defringePurple',0))),(120,float(o.get('defringeGreen',0)))]:
        if amount<=0: continue
        d=np.abs((hsv[...,0]-hue+180)%360-180); m=np.clip(1-d/35,0,1)*(amount/100); hsv[...,1]*=(1-m)
    return hsv_to_rgb_np(hsv)

def apply_geometry_crop(arr,e):
    c=e.get('crop') or {}; g=e.get('geometry') or {}
    im=Image.fromarray((np.clip(arr,0,1)*255).astype(np.uint8),'RGB')
    rot90=int(c.get('rotate90',0))%360
    if rot90: im=im.rotate(-rot90,expand=True,resample=Image.Resampling.BICUBIC)
    if c.get('flipX'): im=ImageOps.mirror(im)
    if c.get('flipY'): im=ImageOps.flip(im)
    angle=float(c.get('angle',0))+float(g.get('rotate',0))
    if abs(angle)>0.001: im=im.rotate(-angle,expand=True,resample=Image.Resampling.BICUBIC)
    arr=np.asarray(im).astype(np.float32)/255
    if cv2 is not None:
        h,w=arr.shape[:2]; upright=str(g.get('upright','off'))
        if upright!='off':
            try:
                gray=cv2.cvtColor((arr*255).astype(np.uint8),cv2.COLOR_RGB2GRAY);edges=cv2.Canny(gray,60,180);lines=cv2.HoughLines(edges,1,np.pi/180,max(80,min(h,w)//5));angles=[]
                if lines is not None:
                    for ln in lines[:80]:
                        theta=float(ln[0][1]);deg=theta*180/math.pi-90
                        if abs(deg)<25:angles.append(deg)
                    if angles:
                        correction=float(np.median(angles));M=cv2.getRotationMatrix2D((w/2,h/2),correction,1);arr=cv2.warpAffine(arr,M,(w,h),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT)
            except Exception: pass
        vert=float(g.get('vertical',0))/100; horiz=float(g.get('horizontal',0))/100; aspect=float(g.get('aspect',0))/100
        src=np.float32([[0,0],[w,0],[w,h],[0,h]])
        dx=horiz*w*.18; dy=vert*h*.18
        dst=np.float32([[0+dx,0+dy],[w-dx,0-dy],[w+dx,h-dy],[0-dx,h+dy]])
        try:
            M=cv2.getPerspectiveTransform(src,dst); arr=cv2.warpPerspective(arr,M,(w,h),flags=cv2.INTER_CUBIC,borderMode=cv2.BORDER_REFLECT)
        except Exception: pass
        if aspect: arr=cv2.resize(arr,(max(1,int(w*(1+aspect*.35))),h),interpolation=cv2.INTER_CUBIC)
        scale=max(.1,float(g.get('scale',100))/100); xoff=float(g.get('x',0))/100; yoff=float(g.get('y',0))/100
        if scale!=1 or xoff or yoff:
            h,w=arr.shape[:2]; nw=max(1,int(w*scale)); nh=max(1,int(h*scale)); tmp=cv2.resize(arr,(nw,nh),interpolation=cv2.INTER_CUBIC)
            canvas=np.zeros_like(arr); sx=max(0,(nw-w)//2-int(xoff*w*.5)); sy=max(0,(nh-h)//2-int(yoff*h*.5)); ex=min(nw,sx+w); ey=min(nh,sy+h)
            crop=tmp[sy:ey,sx:ex]; ch,cw=crop.shape[:2]; canvas[:ch,:cw]=crop; arr=canvas
    h,w=arr.shape[:2]; x=clamp(float(c.get('x',0))); y=clamp(float(c.get('y',0))); cw=clamp(float(c.get('width',1)),.001,1); ch=clamp(float(c.get('height',1)),.001,1)
    l=min(w-1,int(x*w)); t=min(h-1,int(y*h)); r=max(l+1,min(w,int((x+cw)*w))); b=max(t+1,min(h,int((y+ch)*h))); return arr[t:b,l:r]

def raster_mask(mask,h,w,base=None):
    t=mask.get('type','brush'); m=np.zeros((h,w),np.float32)
    if t=='brush':
        if cv2 is not None:
            rad=max(1,int(float(mask.get('size',.04))*min(h,w))); pts=mask.get('points') or []
            for p in pts: cv2.circle(m,(int(p['x']*w),int(p['y']*h)),rad,1,-1,lineType=cv2.LINE_AA)
        else:
            pil=Image.new('L',(w,h),0); d=ImageDraw.Draw(pil); rad=max(1,int(float(mask.get('size',.04))*min(h,w)))
            for p in mask.get('points') or []:
                x=int(p['x']*w);y=int(p['y']*h);d.ellipse((x-rad,y-rad,x+rad,y+rad),fill=255)
            m=np.asarray(pil).astype(np.float32)/255
    elif t=='radial':
        yy,xx=np.mgrid[0:h,0:w]; x=float(mask.get('x',.5))*w;y=float(mask.get('y',.5))*h;rx=max(1,float(mask.get('rx',.25))*w);ry=max(1,float(mask.get('ry',.25))*h); q=((xx-x)/rx)**2+((yy-y)/ry)**2; m=np.clip(1-q,0,1)
    elif t=='linear':
        yy,xx=np.mgrid[0:h,0:w]; ang=math.radians(float(mask.get('angle',0))); cx=float(mask.get('x',.5))*w;cy=float(mask.get('y',.5))*h; v=(xx-cx)*math.cos(ang)+(yy-cy)*math.sin(ang); m=np.clip(.5+v/(max(h,w)*float(mask.get('feather',.25))),0,1)
    elif t=='luminance':
        m[:]=1
    elif t=='color' and base is not None:
        hsv=rgb_to_hsv_np(base);target=float(mask.get('hue',0));rng=max(1,float(mask.get('range',25)));d=np.abs((hsv[...,0]-target+180)%360-180);m=np.clip(1-d/rng,0,1)
    if mask.get('invert'): m=1-m
    feather=float(mask.get('feather',0))
    if feather>0 and cv2 is not None: m=cv2.GaussianBlur(m,(0,0),max(.5,feather*min(h,w)*.03))
    return np.clip(m,0,1)

def local_adjust(base,adj):
    out=base.copy(); out=apply_exposure(out,float(adj.get('exposure',0))); out=tone_regions(out,adj); out=apply_temp_tint(out,adj.get('temperature',0),adj.get('tint',0))
    col={'saturation':adj.get('saturation',0),'vibrance':0,'bw':False,'mixer':{}}; out=apply_color(out,col)
    out=apply_effects(out,{'texture':adj.get('texture',0),'clarity':adj.get('clarity',0),'dehaze':adj.get('dehaze',0),'vignette':0,'grain':0})
    if adj.get('sharpness') or adj.get('noise'): out=apply_detail(out,{'sharpen':adj.get('sharpness',0),'radius':1,'masking':0,'luminanceNR':adj.get('noise',0),'colorNR':0})
    return out

def apply_masks(arr,masks):
    out=arr.copy(); h,w=out.shape[:2]
    for mask in masks or []:
        m=raster_mask(mask,h,w,out)
        if mask.get('type')=='luminance':
            lo,hi=mask.get('range',[0,1]); y=luma(out); m=np.clip((y-lo)/max(.001,(hi-lo)*.25),0,1)*np.clip((hi-y)/max(.001,(hi-lo)*.25),0,1)
        adj=mask.get('adjustments') or {k:mask.get(k,0) for k in ('exposure','contrast','highlights','shadows','whites','blacks','temperature','tint','saturation','texture','clarity','dehaze','sharpness','noise')}
        changed=local_adjust(out,adj); out=out*(1-m[...,None])+changed*m[...,None]
    return np.clip(out,0,1)

def apply_retouch(arr,ops):
    if cv2 is None or not ops: return arr
    out=arr.copy(); h,w=out.shape[:2]
    for op in ops:
        x=int(float(op.get('x',.5))*w); y=int(float(op.get('y',.5))*h); r=max(2,int(float(op.get('size',.03))*min(h,w))); mask=np.zeros((h,w),np.uint8); cv2.circle(mask,(x,y),r,255,-1)
        kind=op.get('type','heal')
        if kind in ('heal','content-aware'):
            out=cv2.inpaint((np.clip(out,0,1)*255).astype(np.uint8),mask,3,cv2.INPAINT_TELEA).astype(np.float32)/255
        elif kind=='clone':
            sx=int(float(op.get('sourceX',.4))*w); sy=int(float(op.get('sourceY',.4))*h); yy0=max(0,y-r);yy1=min(h,y+r);xx0=max(0,x-r);xx1=min(w,x+r); sh=yy1-yy0;sw=xx1-xx0
            sy0=max(0,min(h-sh,sy-r));sx0=max(0,min(w-sw,sx-r)); patch=out[sy0:sy0+sh,sx0:sx0+sw].copy(); mm=mask[yy0:yy1,xx0:xx1].astype(np.float32)/255;out[yy0:yy1,xx0:xx1]=out[yy0:yy1,xx0:xx1]*(1-mm[...,None])+patch*mm[...,None]
    return out


def apply_red_eye(arr,ops):
    if not ops:return arr
    out=arr.copy();h,w=out.shape[:2];yy,xx=np.mgrid[0:h,0:w]
    for op in ops:
        cx=float(op.get('x',.5))*w;cy=float(op.get('y',.5))*h;r=max(2,float(op.get('size',.03))*min(h,w));m=((xx-cx)**2+(yy-cy)**2)<=r*r
        red=out[...,0];green=out[...,1];blue=out[...,2];excess=np.maximum(0,red-np.maximum(green,blue)*1.05);red[m]=np.clip(red[m]-excess[m]*.9,0,1);out[...,0]=red
    return out

def render(input_path,edits,opts=None,max_dim=0):
    arr=load_image(input_path,max_dim=max_dim); e=edits or {}
    arr=apply_geometry_crop(arr,e)
    arr=apply_optics(arr,e.get('optics') or {})
    arr=apply_profile(arr,e.get('profile') or {})
    arr=apply_exposure(arr,(e.get('light') or {}).get('exposure',0))
    arr=tone_regions(arr,e.get('light') or {})
    arr=apply_temp_tint(arr,(e.get('color') or {}).get('temperature',0),(e.get('color') or {}).get('tint',0))
    arr=apply_curves(arr,e.get('curves') or {})
    arr=apply_color(arr,e.get('color') or {})
    arr=apply_calibration(arr,e.get('calibration') or {})
    arr=apply_grading(arr,e.get('grading') or {})
    arr=apply_effects(arr,e.get('effects') or {})
    arr=apply_detail(arr,e.get('detail') or {})
    arr=apply_masks(arr,e.get('masks') or [])
    arr=apply_retouch(arr,e.get('retouch') or [])
    arr=apply_red_eye(arr,e.get('redEye') or [])
    return np.clip(arr,0,1)

def cmd_render(a):
    e=jload(a.edits,{}); o=jload(a.options,{})
    arr=render(a.input,e,o,max_dim=a.max_dim or 0); save_image(arr,a.output,o)
    if o.get('includeMetadata'):
        try:
            subprocess.run(['exiftool','-TagsFromFile',a.input,'-all:all','-overwrite_original',a.output],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
            if o.get('removeLocation'): subprocess.run(['exiftool','-gps:all=','-overwrite_original',a.output],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        except Exception: pass
    if o.get('contentCredentials'):
        import hashlib,time
        h=hashlib.sha256(Path(a.output).read_bytes()).hexdigest(); Path(a.output+'.content-credentials.json').write_text(json.dumps({'sha256':h,'created':time.time(),'generator':'Lumina Photo Studio','edits':e},indent=2),encoding='utf-8')
    print(json.dumps({'ok':True,'output':a.output,'width':arr.shape[1],'height':arr.shape[0]}))

def cmd_metadata(a):
    info={}
    try:
        im=Image.open(a.input); ex=im.getexif(); info={'width':im.width,'height':im.height,'format':im.format,'mode':im.mode,'exif':{str(k):str(v) for k,v in ex.items()}}
    except Exception as e: info={'error':str(e)}
    if rawpy and Path(a.input).suffix.lower() in RAW_EXTS:
        try:
            with rawpy.imread(a.input) as r: info.update({'raw':True,'rawWidth':r.sizes.raw_width,'rawHeight':r.sizes.raw_height,'visibleWidth':r.sizes.width,'visibleHeight':r.sizes.height})
        except Exception: pass
    print(json.dumps(info))

def cmd_hdr(a):
    if cv2 is None: raise RuntimeError('OpenCV required')
    imgs=[cv2.cvtColor((load_image(p)*255).astype(np.uint8),cv2.COLOR_RGB2BGR) for p in a.inputs]
    times=np.array([1/float(x) for x in (a.shutters or [30]*len(imgs))],dtype=np.float32)
    if len(times)!=len(imgs): times=np.geomspace(1/250,1/15,len(imgs)).astype(np.float32)
    calibrate=cv2.createCalibrateDebevec(); response=calibrate.process(imgs,times=times); merge=cv2.createMergeDebevec(); hdr=merge.process(imgs,times=times,response=response); tonemap=cv2.createTonemapReinhard(gamma=1.0,intensity=0,light_adapt=.8,color_adapt=0); ldr=tonemap.process(hdr); arr=cv2.cvtColor(np.clip(ldr,0,1),cv2.COLOR_BGR2RGB); save_image(arr,a.output,{'quality':95}); print(json.dumps({'ok':True,'output':a.output}))

def cmd_panorama(a):
    if cv2 is None: raise RuntimeError('OpenCV required')
    imgs=[cv2.cvtColor((load_image(p)*255).astype(np.uint8),cv2.COLOR_RGB2BGR) for p in a.inputs]; stitcher=cv2.Stitcher_create(cv2.Stitcher_PANORAMA); status,pano=stitcher.stitch(imgs)
    if status!=cv2.Stitcher_OK: raise RuntimeError(f'Panorama stitch failed: {status}')
    arr=cv2.cvtColor(pano,cv2.COLOR_BGR2RGB).astype(np.float32)/255; save_image(arr,a.output,{'quality':95}); print(json.dumps({'ok':True,'output':a.output}))

def _torch_device():
    import torch
    return 'cuda' if torch.cuda.is_available() else 'cpu'

def ai_segment(input_path,feature,prompt=''):
    from transformers import pipeline
    im=Image.open(input_path).convert('RGB'); w,h=im.size
    # panoptic segmentation provides person/object masks; semantic ADE model is useful for sky/landscape.
    if feature in ('sky-mask','landscape-mask','background-mask'):
        seg=pipeline('image-segmentation',model=os.getenv('LUMINA_SEGMENT_MODEL','nvidia/segformer-b5-finetuned-ade-640-640'),device=0 if _torch_device()=='cuda' else -1)
        items=seg(im)
        labels=[]
        wants={'sky-mask':['sky'],'landscape-mask':['tree','grass','plant','mountain','water','sea','earth','field'],'background-mask':[]}[feature]
        acc=np.zeros((h,w),np.float32)
        for it in items:
            lab=str(it.get('label','')).lower(); m=np.asarray(it['mask'].resize((w,h))).astype(np.float32)/255
            if feature=='background-mask': acc=np.maximum(acc,m)
            elif any(x in lab for x in wants): acc=np.maximum(acc,m);labels.append(lab)
        if feature=='background-mask':
            # subject approximation is strongest central foreground; invert that below if available
            center=np.zeros_like(acc);yy,xx=np.mgrid[0:h,0:w];center=np.exp(-(((xx-w/2)/(w*.45))**2+((yy-h/2)/(h*.45))**2));acc=np.clip(acc*(1-center*.25),0,1)
        return acc,labels
    seg=pipeline('image-segmentation',model=os.getenv('LUMINA_OBJECT_MODEL','facebook/mask2former-swin-large-coco-panoptic'),device=0 if _torch_device()=='cuda' else -1)
    items=seg(im); masks=[]
    for it in items:
        lab=str(it.get('label','')).lower(); m=np.asarray(it['mask'].resize((w,h))).astype(np.float32)/255; masks.append((lab,m))
    if feature=='people-mask': chosen=[m for lab,m in masks if 'person' in lab]
    elif feature=='object-mask' and prompt: chosen=[m for lab,m in masks if prompt.lower() in lab]
    elif feature=='subject-mask':
        # choose large, central, non-stuff region
        def score(lm):
            lab,m=lm; area=m.mean(); yy,xx=np.mgrid[0:h,0:w]; cent=(m*np.exp(-(((xx-w/2)/(w*.4))**2+((yy-h/2)/(h*.4))**2))).mean(); return area*.35+cent*.65
        chosen=[max(masks,key=score)[1]] if masks else []
    else: chosen=[m for _,m in masks]
    acc=np.zeros((h,w),np.float32)
    for m in chosen: acc=np.maximum(acc,m)
    return acc,[lab for lab,m in masks if m in chosen] if False else []

def ai_depth(input_path):
    import torch
    from transformers import pipeline
    im=Image.open(input_path).convert('RGB'); depth_pipe=pipeline('depth-estimation',model=os.getenv('LUMINA_DEPTH_MODEL','depth-anything/Depth-Anything-V2-Small-hf'),device=0 if _torch_device()=='cuda' else -1)
    r=depth_pipe(im); d=np.asarray(r['depth'].resize(im.size)).astype(np.float32); d=(d-d.min())/(d.max()-d.min()+1e-6); return d

def ai_superres(input_path,output,scale=2):
    import torch
    from transformers import Swin2SRImageProcessor,Swin2SRForImageSuperResolution
    model_id=os.getenv('LUMINA_SR_MODEL','caidas/swin2SR-classical-sr-x2-64'); proc=Swin2SRImageProcessor.from_pretrained(model_id); model=Swin2SRForImageSuperResolution.from_pretrained(model_id).to(_torch_device()); im=Image.open(input_path).convert('RGB'); inputs=proc(images=im,return_tensors='pt').to(_torch_device())
    with torch.no_grad(): out=model(**inputs).reconstruction.data.squeeze().float().cpu().clamp_(0,1).numpy()
    arr=np.moveaxis(out,0,-1); save_image(arr,output,{'quality':95}); return {'output':output,'width':arr.shape[1],'height':arr.shape[0]}

def ai_inpaint(input_path,mask_path,output,prompt='clean natural background'):
    import torch
    from diffusers import AutoPipelineForInpainting
    model_id=os.getenv('LUMINA_INPAINT_MODEL','diffusers/stable-diffusion-xl-1.0-inpainting-0.1'); dtype=torch.float16 if _torch_device()=='cuda' else torch.float32
    pipe=AutoPipelineForInpainting.from_pretrained(model_id,torch_dtype=dtype).to(_torch_device()); im=Image.open(input_path).convert('RGB'); mask=Image.open(mask_path).convert('L').resize(im.size)
    result=pipe(prompt=prompt,image=im,mask_image=mask,strength=.99,guidance_scale=7.0,num_inference_steps=30).images[0]; result.save(output); return {'output':output}

def ai_lens_blur(input_path,output,amount=50,focus=.5):
    arr=load_image(input_path); d=ai_depth(input_path); h,w=arr.shape[:2]
    if d.shape!=(h,w): d=np.asarray(Image.fromarray((d*255).astype(np.uint8)).resize((w,h))).astype(np.float32)/255
    dist=np.abs(d-float(focus)); sigma=max(.5,float(amount)/12); blurred=cv2.GaussianBlur(arr,(0,0),sigma) if cv2 is not None else np.asarray(Image.fromarray((arr*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(sigma))).astype(np.float32)/255
    alpha=np.clip(dist*(float(amount)/20),0,1)[...,None]; out=arr*(1-alpha)+blurred*alpha; save_image(out,output,{'quality':95}); return {'output':output}

def ai_auto_light(input_path):
    arr=load_image(input_path,max_dim=1800); y=luma(arr); p1,p50,p99=np.percentile(y,[1,50,99]); exp=float(np.log2(.45/max(.02,p50))); shadows=float(clamp((.16-p1)*350,-100,100)); highlights=float(clamp((.88-p99)*300,-100,100)); contrast=float(clamp((p99-p1-.72)*80,-40,40)); sat=float(clamp((np.std(arr,axis=(0,1)).mean()-.2)*80,-20,20))
    return {'light':{'exposure':round(exp,2),'contrast':round(contrast,1),'highlights':round(highlights,1),'shadows':round(shadows,1),'whites':0,'blacks':0},'color':{'temperature':0,'tint':0,'vibrance':round(sat,1),'saturation':0}}

def ai_cull(inputs):
    out=[]
    face_cascade=None; eye_cascade=None
    if cv2 is not None:
        try:
            face_cascade=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_frontalface_default.xml'); eye_cascade=cv2.CascadeClassifier(cv2.data.haarcascades+'haarcascade_eye.xml')
        except Exception: pass
    for p in inputs:
        arr=load_image(p,max_dim=1600); gray=(luma(arr)*255).astype(np.uint8); sharp=float(cv2.Laplacian(gray,cv2.CV_64F).var()) if cv2 is not None else float(np.var(gray)); exposure=float(np.mean(gray)); clipped=float(((gray<3)|(gray>252)).mean()); faces=0;eyes=0
        if face_cascade is not None:
            fs=face_cascade.detectMultiScale(gray,1.1,4,minSize=(32,32)); faces=len(fs)
            if eye_cascade is not None:
                for x,y,w,h in fs: eyes+=len(eye_cascade.detectMultiScale(gray[y:y+h,x:x+w],1.1,4,minSize=(8,8)))
        score=clamp((math.log1p(sharp)/8)*.55 + (1-abs(exposure-128)/128)*.25 + (1-clipped)*.15 + min(faces,1)*.05,0,1)
        out.append({'path':p,'score':round(score*100,1),'sharpness':round(sharp,1),'meanExposure':round(exposure,1),'clippedPct':round(clipped*100,2),'faces':faces,'eyes':eyes,'recommendation':'select' if score>.62 else 'reject' if score<.4 else 'review'})
    return out

def cmd_ai(a):
    feature=a.feature; payload=jload(a.payload,{})
    if feature.endswith('-mask'):
        mask,labels=ai_segment(a.input,feature,payload.get('prompt','')); out=a.output or str(Path(a.input).with_suffix('.mask.png')); Image.fromarray((mask*255).astype(np.uint8),'L').save(out); result={'output':out,'labels':labels}
    elif feature=='lens-blur-depth': result=ai_lens_blur(a.input,a.output,payload.get('amount',50),payload.get('focus',.5))
    elif feature in ('super-resolution','raw-details'): result=ai_superres(a.input,a.output,payload.get('scale',2))
    elif feature in ('generative-remove','distraction-people','distraction-reflections'):
        mask_path=payload.get('maskPath');
        if not mask_path and feature=='distraction-people':
            m,_=ai_segment(a.input,'people-mask'); mask_path=a.output+'.mask.png'; Image.fromarray((m*255).astype(np.uint8),'L').save(mask_path)
        if not mask_path: raise RuntimeError('maskPath is required for this inpainting operation')
        result=ai_inpaint(a.input,mask_path,a.output,payload.get('prompt','clean natural background'))
    elif feature=='denoise':
        arr=load_image(a.input); arr=apply_detail(arr,{'luminanceNR':payload.get('amount',60),'colorNR':payload.get('amount',60),'sharpen':10,'radius':1}); save_image(arr,a.output,{'quality':95}); result={'output':a.output}
    elif feature=='ai-sharpen':
        arr=load_image(a.input); arr=apply_detail(arr,{'sharpen':payload.get('amount',75),'radius':.7,'masking':20,'luminanceNR':0,'colorNR':0}); save_image(arr,a.output,{'quality':95}); result={'output':a.output}
    elif feature=='distraction-dust':
        arr=load_image(a.input); gray=luma(arr); blur=cv2.GaussianBlur(gray,(0,0),12) if cv2 is not None else gray; diff=blur-gray; thr=np.percentile(diff,99.85); mask=(diff>thr).astype(np.uint8)*255
        if cv2 is not None: mask=cv2.dilate(mask,np.ones((3,3),np.uint8),iterations=1); out=cv2.inpaint((arr*255).astype(np.uint8),mask,3,cv2.INPAINT_TELEA).astype(np.float32)/255
        else: out=arr
        save_image(out,a.output,{'quality':95}); Image.fromarray(mask).save(a.output+'.mask.png'); result={'output':a.output,'mask':a.output+'.mask.png'}
    elif feature=='blemish-retouch':
        arr=load_image(a.input); hsv=rgb_to_hsv_np(arr); skin=((hsv[...,0]<50)|(hsv[...,0]>340))&(hsv[...,1]>.08)&(hsv[...,1]<.7); y=luma(arr); med=cv2.medianBlur((y*255).astype(np.uint8),9).astype(np.float32)/255 if cv2 is not None else y; diff=np.abs(y-med); mask=(skin&(diff>np.percentile(diff[skin],97) if skin.any() else diff>.2)).astype(np.uint8)*255
        out=cv2.inpaint((arr*255).astype(np.uint8),mask,2,cv2.INPAINT_TELEA).astype(np.float32)/255 if cv2 is not None else arr; save_image(out,a.output,{'quality':95}); result={'output':a.output}
    elif feature=='assisted-culling': result={'items':ai_cull(payload.get('inputs') or [a.input])}
    elif feature in ('auto-light-color','recommended-presets','adaptive-presets','adaptive-profiles'):
        auto=ai_auto_light(a.input)
        if feature=='recommended-presets': result={'presets':[{'name':'Auto Balanced','edits':auto},{'name':'Clean Contrast','edits':{'light':{**auto['light'],'contrast':auto['light']['contrast']+18},'color':{**auto['color'],'vibrance':auto['color']['vibrance']+10}}}]}
        elif feature=='adaptive-profiles': result={'profile':{'name':'Adaptive','amount':100,'edits':auto}}
        elif feature=='adaptive-presets': result={'preset':{'name':'Adaptive Scene','edits':auto,'requiresMasks':['subject-mask','sky-mask']}}
        else: result=auto
    else: raise RuntimeError('Unsupported AI feature')
    print(json.dumps({'ok':True,**result}))

def cmd_video(a):
    opts=jload(a.options,{});e=opts.get('edits') or {};light=e.get('light') or {};color=e.get('color') or {};effects=e.get('effects') or {};crop=e.get('crop') or {};geom=e.get('geometry') or {}
    filters=[]
    exp=float(light.get('exposure',opts.get('exposure',0)));contrast=float(light.get('contrast',opts.get('contrast',0)));sat=float(color.get('saturation',opts.get('saturation',0)))+float(color.get('vibrance',0))*.45
    filters.append(f"eq=brightness={max(-1,min(1,(2**exp-1)*.18)):.5f}:contrast={max(.1,1+contrast/100):.5f}:saturation={max(0,1+sat/100):.5f}")
    temp=float(color.get('temperature',0))/100;tint=float(color.get('tint',0))/100
    if temp or tint:
        rr=1+temp*.12+tint*.03;gg=1-abs(tint)*.03;bb=1-temp*.12+tint*.03;filters.append(f"colorchannelmixer=rr={rr:.4f}:gg={gg:.4f}:bb={bb:.4f}")
    if color.get('bw'): filters.append('hue=s=0')
    if effects.get('vignette'): filters.append(f"vignette=PI/4:{max(0,.5+float(effects.get('vignette',0))/200):.3f}")
    if effects.get('grain'): filters.append(f"noise=alls={max(0,float(effects.get('grain',0))*.25):.2f}:allf=t")
    if effects.get('clarity') or effects.get('dehaze'): filters.append(f"unsharp=5:5:{(float(effects.get('clarity',0))+float(effects.get('dehaze',0))*.6)/100:.3f}:5:5:0")
    if crop.get('width',1)<.999 or crop.get('height',1)<.999 or crop.get('x',0)>0 or crop.get('y',0)>0:
        filters.append(f"crop=iw*{float(crop.get('width',1))}:ih*{float(crop.get('height',1))}:iw*{float(crop.get('x',0))}:ih*{float(crop.get('y',0))}")
    rot=int(crop.get('rotate90',0))%360
    if rot==90:filters.append('transpose=1')
    elif rot==270:filters.append('transpose=2')
    elif rot==180:filters.append('hflip,vflip')
    if crop.get('flipX'):filters.append('hflip')
    if crop.get('flipY'):filters.append('vflip')
    angle=float(crop.get('angle',0))+float(geom.get('rotate',0))
    if abs(angle)>.01: filters.append(f"rotate={-angle}*PI/180:fillcolor=black@0")
    trim=[]
    if opts.get('start') is not None: trim+=['-ss',str(opts['start'])]
    if opts.get('end') is not None: trim+=['-to',str(opts['end'])]
    cmd=['ffmpeg','-y',*trim,'-i',a.input]
    if filters: cmd+=['-vf',','.join(filters)]
    cmd+=['-c:v','libx264','-crf',str(opts.get('crf',18)),'-preset','medium','-c:a','aac','-b:a','192k',a.output]
    subprocess.check_call(cmd); print(json.dumps({'ok':True,'output':a.output}))

def cmd_gallery(a):
    items=jload(a.payload,{}).get('items',[]); title=jload(a.payload,{}).get('title','Lumina Gallery')
    cards='\n'.join([f'<figure><img src="{it.get("src","")}" alt=""><figcaption>{it.get("caption","")}</figcaption></figure>' for it in items])
    html=f'''<!doctype html><meta charset="utf-8"><title>{title}</title><style>body{{font-family:system-ui;background:#111;color:#eee;margin:0}}header{{padding:30px}}main{{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:8px;padding:8px}}img{{width:100%;display:block}}figcaption{{padding:8px}}figure{{margin:0;background:#1b1b1b}}</style><header><h1>{title}</h1></header><main>{cards}</main>'''
    Path(a.output).write_text(html,encoding='utf-8'); print(json.dumps({'ok':True,'output':a.output}))

def main():
    p=argparse.ArgumentParser(); sp=p.add_subparsers(dest='cmd',required=True)
    r=sp.add_parser('render');r.add_argument('--input',required=True);r.add_argument('--output',required=True);r.add_argument('--edits');r.add_argument('--options');r.add_argument('--max-dim',type=int,default=0);r.set_defaults(fn=cmd_render)
    m=sp.add_parser('metadata');m.add_argument('--input',required=True);m.set_defaults(fn=cmd_metadata)
    h=sp.add_parser('hdr');h.add_argument('--inputs',nargs='+',required=True);h.add_argument('--output',required=True);h.add_argument('--shutters',nargs='*',type=float);h.set_defaults(fn=cmd_hdr)
    pa=sp.add_parser('panorama');pa.add_argument('--inputs',nargs='+',required=True);pa.add_argument('--output',required=True);pa.set_defaults(fn=cmd_panorama)
    ai=sp.add_parser('ai');ai.add_argument('--feature',required=True);ai.add_argument('--input',required=True);ai.add_argument('--output');ai.add_argument('--payload');ai.set_defaults(fn=cmd_ai)
    v=sp.add_parser('video');v.add_argument('--input',required=True);v.add_argument('--output',required=True);v.add_argument('--options');v.set_defaults(fn=cmd_video)
    g=sp.add_parser('gallery');g.add_argument('--payload',required=True);g.add_argument('--output',required=True);g.set_defaults(fn=cmd_gallery)
    a=p.parse_args()
    try: a.fn(a)
    except Exception as e:
        print(json.dumps({'ok':False,'error':str(e)})); sys.exit(2)
if __name__=='__main__': main()
