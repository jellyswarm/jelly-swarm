import React from 'react';
import { createRoot } from 'react-dom/client';
import EyeButton from './eye/EyeButton';
const root=document.getElementById('jelly-ink-button');
if(root)createRoot(root).render(<EyeButton href="/dashboard" className="jelly-eye-cta" fontSize={19} paddingX={28} paddingY={12} eyeSize={35} eyeGap={4} theme={{button:'#9f237d',text:'#ffffff',eye:'#fff5fc',pupil:'#3c1740',shadow:'rgb(75 25 78 / 0.35)'}}>Continue to dashboard</EyeButton>);
