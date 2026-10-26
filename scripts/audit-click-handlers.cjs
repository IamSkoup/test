#!/usr/bin/env node
'use strict';
// A static inventory: inline click handlers must resolve to window properties,
// not module/IIFE-local functions. This complements the browser smoke pass.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const files=['index.html','assets/kapani-main-classic.js','assets/kapani-pack-classic.js'];
const sources=files.map(p=>fs.readFileSync(path.join(root,p),'utf8'));
const full=sources.join('\n');
const names=new Map();
const onclick=/\bonclick\s*=\s*["']\s*(?:event\.stopPropagation\(\);\s*)?([A-Za-z_$][\w$]*)\s*\(/g;
for(let i=0;i<sources.length;i++){
  for(const match of sources[i].matchAll(onclick)){
    const name=match[1];
    if(['if','for','while','switch'].includes(name))continue;
    if(!names.has(name))names.set(name,new Set());
    names.get(name).add(files[i]);
  }
}
const missing=[];
for(const [name,owners] of names){
  // Treat an explicit window export/assignment as callable. Note: index.html
  // still has classic inline scripts that declare functions globally.
  const exported=new RegExp(`(?:window|globalThis)\\s*(?:\\.\\s*${name}\\b|\\[\\s*['\"]${name}['\"]\\s*\\])`).test(full);
  const globalInline=/\bfunction\s+/.test(sources[0])&&
    new RegExp(`\\bfunction\\s+${name}\\s*\\(`).test(sources[0]);
  if(!exported&&!globalInline)missing.push({name,files:[...owners]});
}
console.log(JSON.stringify({scanned:files,handlerCount:[...names].length,missing},null,2));
