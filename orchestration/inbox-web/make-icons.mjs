// 标准库生成 PWA 的两种 PNG 尺寸；与 icon.svg 的收件箱图形一致。
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
const crc = bytes => { let value=0xffffffff;for(const byte of bytes){value^=byte;for(let n=0;n<8;n++)value=(value>>>1)^((value&1)?0xedb88320:0);}return (value^0xffffffff)>>>0; };
function chunk(type,bytes) { const header=Buffer.alloc(8);header.writeUInt32BE(bytes.length);header.write(type,4);const content=Buffer.concat([Buffer.from(type),bytes]),tail=Buffer.alloc(4);tail.writeUInt32BE(crc(content));return Buffer.concat([header,bytes,tail]); }
const segments=[[13,35,25,35],[25,35,29,41],[29,41,35,41],[35,41,39,35],[39,35,51,35],[19,17,45,17],[45,17,51,35],[51,35,51,48],[51,48,13,48],[13,48,13,35],[13,35,19,17]];
for(const size of [192,512]) {
  const pixels=Buffer.alloc((size*4+1)*size);
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const a=x*64/size,b=y*64/size,edgeX=Math.max(15-a,0,a-49),edgeY=Math.max(15-b,0,b-49),inside=edgeX*edgeX+edgeY*edgeY<=225;
    const white=segments.some(([x1,y1,x2,y2])=>{const dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((a-x1)*dx+(b-y1)*dy)/(dx*dx+dy*dy)));return Math.hypot(a-x1-dx*t,b-y1-dy*t)<=2;});
    const offset=y*(size*4+1)+1+x*4;pixels.set(white?[255,255,255,255]:[88,71,210,inside?255:0],offset);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  writeFileSync(new URL(`./public/icon-${size}.png`,import.meta.url),Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]));
}
