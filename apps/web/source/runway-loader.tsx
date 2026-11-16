import React, {useEffect, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {motion, AnimatePresence} from 'framer-motion';

/* Adapted from the supplied RunwayLoader: the reference track, fill, travel,
   percentage and phase labels remain, with the plane replaced by our runner.
   Progress never exceeds measured image/font readiness. */
function RunwayLoader(){
 const [progress,setProgress]=useState(0),[visible,setVisible]=useState(true);
 useEffect(()=>{
  let active=true,frame=0,completed=0,ready=false,finishing=false;
  const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.documentElement.classList.add('is-loading');
  const background=Array.from(document.body.children).filter((el):el is HTMLElement=>el instanceof HTMLElement&&el.id!=='jelly-loader'&&el.tagName!=='SCRIPT');background.forEach(el=>el.inert=true);
  const start=performance.now();
  const images=Array.from(document.images);
  const tasks:Promise<unknown>[]=images.map(img=>img.complete?Promise.resolve():new Promise(resolve=>{img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true})}));
  const sprite=new Image();sprite.src='assets/mascot-run-strip.png';tasks.push(sprite.decode().catch(()=>{}));
  if(document.fonts?.ready)tasks.push(document.fonts.ready);
  tasks.forEach(task=>task.then(()=>completed++,()=>completed++));
  Promise.allSettled(tasks).then(()=>{ready=true});
  const finish=()=>{if(!active||finishing)return;finishing=true;document.documentElement.classList.remove('is-loading');background.forEach(el=>el.inert=false);setVisible(false)};
  function tick(now:number){if(!active)return;const elapsed=now-start,t=Math.min(elapsed/(reduced?1:5500),1);const motion=t<=.75?(t/.75)*.82:.82+(1-Math.pow(1-(t-.75)/.25,2))*.18;const readiness=completed/Math.max(1,tasks.length);const next=Math.min(motion,readiness);setProgress(Math.floor(next*100));if(ready&&t>=1){setProgress(100);setTimeout(finish,reduced?0:300);return}if(elapsed>9500){finish();return}frame=requestAnimationFrame(tick)}
  frame=requestAnimationFrame(tick);return()=>{active=false;cancelAnimationFrame(frame);background.forEach(el=>el.inert=false);document.documentElement.classList.remove('is-loading')};
 },[]);
 const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;
 return <AnimatePresence>{visible&&<motion.div className="runway-loader" role="status" aria-label="Loading JellySwarm" initial={{opacity:1}} exit={{opacity:0}} transition={{duration:reduced?0:.4}}>
 <div className="runway-inner"><div className="runway-brand"><img src="assets/jelly-logo.jpg" alt=""/><span>JellySwarm</span></div>
 <div className="runway-track"><div className="runway-dashes"/><div className="runway-fill" style={{width:`${progress}%`}}/><div className="runner-position" style={{left:`${Math.min(progress,94)}%`}}><div className="runner-sprite" aria-hidden="true"/></div></div>
 <div className="runway-status"><strong>{progress}</strong><span>%</span><small>{progress===100?'READY TO GO':'GATHERING THE SWARM'}</small></div></div></motion.div>}</AnimatePresence>
}
const root=document.getElementById('jelly-loader');if(root)createRoot(root).render(<RunwayLoader/>);
