#!/usr/bin/env python3
import json,sys
from PIL import Image,ImageEnhance
src,dst=sys.argv[1],sys.argv[2]
opts=json.loads(sys.argv[3]) if len(sys.argv)>3 else {}
im=Image.open(src).convert('RGB')
im=ImageEnhance.Contrast(im).enhance(float(opts.get('contrast',1.08)))
im.save(dst,quality=95)
