import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import GlassTabs from './glass/GlassTabs';
declare global {interface Window {jellyNavigate?: (href:string)=>void}}
const root=document.getElementById('glass-nav');
if(root){
 const base=root.dataset.base || '';
 const paths=['','pages/agents','pages/how-it-works','pages/system'];
 const labels=['Home','The team','How it works','The system'];
 const index=Math.max(0,paths.findIndex((p,i)=>i===0?location.pathname.endsWith('/'):location.pathname.endsWith('/'+p)));
 function Nav(){const [value,setValue]=useState(index);return <GlassTabs items={labels} value={value} maxHeight={50} minHeight={42} onChange={(i)=>{setValue(i);const href=base+paths[i];setTimeout(()=>window.jellyNavigate?window.jellyNavigate(href):location.assign(href),220)}}/>}
 createRoot(root).render(<Nav/>);
}
