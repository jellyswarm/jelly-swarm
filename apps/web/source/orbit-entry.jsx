import React from 'react';
import {createRoot} from 'react-dom/client';
import OrbitGallery from './orbit/OrbitGallery';
const root=document.getElementById('swarm-orbit');
const jellies=['02-scout.webp','01-planner.webp','03-checker.webp','04-merger.webp','05-receipt.webp','06-watcher.webp'].map(src=>({src:'assets/'+src,alt:'',ratio:1}));
const rings=[{count:4,radius:.35,size:.145,period:75,direction:1},{count:7,radius:.52,size:.14,period:115,direction:-1},{count:9,radius:.70,size:.15,period:160,direction:1}];
if(root)createRoot(root).render(<OrbitGallery className="swarm-orbit" label="JellySwarm mascot orbit. Drag or use the left and right arrow keys to spin." tabIndex={0} items={jellies} rings={rings} eyebrow="THE SWARM IN MOTION" title={'Meet the swarm where\nyou work.'} subtitle="Little helpers for your next big idea. Drag to give them a spin." theme={{background:'#f4edf5',card:'#ead9f2',eyebrow:'#795075',title:'#201832',subtitle:'#695c70',shadow:'rgba(66,34,75,.18)'}} copyWidth={.60} grain={0} edgeFade={.9} lean={15} hoverScale={1.18}/>);
