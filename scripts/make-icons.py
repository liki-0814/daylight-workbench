"""Generate the existing Daylight mark as macOS app and monochrome tray assets."""
from pathlib import Path
import math,struct,zlib,subprocess
root=Path(__file__).resolve().parents[1]
build=root/'build';build.mkdir(exist_ok=True)
def png(file,n,tray=False):
    rows=[]
    for y in range(n):
        row=bytearray()
        for x in range(n):
            px=(x+.5)/n*40;py=(y+.5)/n*40
            r=10
            arc=py<=25 and abs(math.hypot(px-20,py-25)-r)<1
            line=(7<=px<=33 and abs(py-29)<1) or (abs(px-20)<1 and 6<=py<=11)
            left=6<=px<=11 and abs(py-(15+(px-7)*2/3))<1
            right=29<=px<=34 and abs(py-(15+(33-px)*2/3))<1
            mark=arc or line or left or right
            if tray: c=(0,0,0,255 if mark else 0)
            else:
                dx=max(abs(px-20)-11,0);dy=max(abs(py-20)-11,0)
                inside=dx*dx+dy*dy<=64
                c=(243,243,223,255) if mark else ((48,75,62,255) if inside else (0,0,0,0))
            row.extend(c)
        rows.append(b'\0'+row)
    def chunk(t,data):return struct.pack('>I',len(data))+t+data+struct.pack('>I',zlib.crc32(t+data)&0xffffffff)
    file.write_bytes(b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',n,n,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b''))
png(build/'icon.png',1024)
png(build/'trayTemplate.png',20,True);png(build/'trayTemplate@2x.png',40,True)
iconset=build/'icon.iconset';iconset.mkdir(exist_ok=True)
for n in [16,32,128,256,512]:
    for scale in [1,2]:
        target=iconset/f'icon_{n}x{n}{"@2x" if scale==2 else ""}.png'
        subprocess.run(['sips','-z',str(n*scale),str(n*scale),str(build/'icon.png'),'--out',str(target)],check=True,stdout=subprocess.DEVNULL)
subprocess.run(['iconutil','-c','icns',str(iconset),'-o',str(build/'icon.icns')],check=True)
