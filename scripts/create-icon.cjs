'use strict';
// Produce our original vector mark as a PNG and a PNG-backed Windows icon.
const fs=require('node:fs');const path=require('node:path');const zlib=require('node:zlib');
const size=256, samples=4;
const shapeA=[[17,18],[51,18],[42,29],[31,29],[18,48],[7,48],[22,25],[14,25]];
const shapeB=[[38,32],[50,32],[38,48],[26,48]];
function inside(poly,x,y){let hit=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const [a,b]=poly[i],[c,d]=poly[j];if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)hit=!hit;}return hit;}
function rounded(x,y){const dx=Math.max(18-x,0,x-46),dy=Math.max(18-y,0,y-46);return dx*dx+dy*dy<=18*18;}
const raw=Buffer.alloc((size*4+1)*size);
for(let y=0;y<size;y++)for(let x=0;x<size;x++){let alpha=0,ink=0;for(let sy=0;sy<samples;sy++)for(let sx=0;sx<samples;sx++){const px=(x+(sx+.5)/samples)/4,py=(y+(sy+.5)/samples)/4;if(rounded(px,py)){alpha++;if(inside(shapeA,px,py)||inside(shapeB,px,py))ink++;}}const p=y*(size*4+1)+1+x*4;const mix=alpha?ink/alpha:0;raw[p]=198*(1-mix)+21*mix;raw[p+1]=244*(1-mix)+23*mix;raw[p+2]=91*(1-mix)+19*mix;raw[p+3]=255*alpha/(samples*samples);}
function crc32(buffer){let c=0xffffffff;for(const b of buffer){c^=b;for(let i=0;i<8;i++)c=c&1?(c>>>1)^0xedb88320:c>>>1;}return (c^0xffffffff)>>>0;}
function chunk(type,data){const name=Buffer.from(type),len=Buffer.alloc(4),crc=Buffer.alloc(4);len.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([len,name,data,crc]);}
const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
const png=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
const directory=path.join(__dirname,'../desktop/assets');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'icon.png'),png);
const ico=Buffer.alloc(22);ico.writeUInt16LE(1,2);ico.writeUInt16LE(1,4);ico.writeUInt16LE(1,10);ico.writeUInt16LE(32,12);ico.writeUInt32LE(png.length,14);ico.writeUInt32LE(22,18);fs.writeFileSync(path.join(directory,'icon.ico'),Buffer.concat([ico,png]));
console.log('Generated Turbo Browser application icons.');
