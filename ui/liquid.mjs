// DOM material adapter. SVG pipeline adapted from GlassMaterial.tsx:
// Copyright (c) 2026 Sam Asante. MIT License.
// Source commit 950bef3966eba5077b1e38895f3c1bb2dae2a9d9.
// See THIRD-PARTY-NOTICES.md. No React, WebGL, or continuous render loop.
import { createLensMapGenerator, DISPERSION_SPREAD } from './liquid-optics.mjs';
const NS = 'http://www.w3.org/2000/svg';
const svgNode = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
};
export function initializeLiquidGlass(selector, {nativeSelector = selector} = {}) {
  const elements = [...document.querySelectorAll(selector)];
  // CSS/SVG can sample web content only, never the native desktop beneath an
  // Electron window. Its opaque displacement-map flood would mask that desktop.
  // Native windows keep their real alpha and use the CSS rim/highlight material.
  if (window.timer) {
    for (const element of elements) element.dataset.liquid = 'native';
    return initializeNativeLight(elements,nativeSelector);
  }
  // The app bundles Chromium. Other engines retain the CSS frost/highlight fallback.
  const blink = /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent) &&
    !/iPhone|iPad|iPod|CriOS|FxiOS/.test(navigator.userAgent);
  const defsRoot = svgNode('svg', { width:0, height:0, 'aria-hidden':'true', class:'liquid-defs' });
  const defs = svgNode('defs');
  defsRoot.append(defs);
  document.body.append(defsRoot);
  const records = new Map();
  let nextId = 0, frame = 0, lightFrame = 0, pointer = null, disposed = false;
  const pending = new Set();
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  function update(element) {
    if (disposed) return;
    const width = Math.round(element.clientWidth);
    const height = Math.round(element.clientHeight);
    if (width < 8 || height < 8) return;
    const computedRadius = getComputedStyle(element).borderTopLeftRadius;
    const radius = Math.min((parseFloat(computedRadius)||0)*(computedRadius.includes('%')?Math.min(width,height)/100:1),Math.min(width,height)/2);
    const key = [width,height,radius].join(':');
    let record = records.get(element);
    if (record?.key === key) return;
    if (!blink) { element.dataset.liquid = 'fallback'; return; }
    try {
      if (!record) {
        record = { id:++nextId, version:0, generator:createLensMapGenerator(width < 160 ? 256 : 384) };
        records.set(element,record);
      }
      const map = record.generator.generate({
        lensHalfWidth:width/2, lensHalfHeight:height/2, borderRadius:radius,
        depth:.4, clipToShape:true, softEdge:true, curvature:.18,
        bend:.65, bendWidth:.18, sheenAngle:45, sheen:.22,
        sheenWidth:3, sheenFalloff:1.5, glow:.05, glowSpread:1, glowFalloff:.7
      });
      const scale = Math.min(22, Math.max(7, Math.sqrt((width*width+height*height)/2)*.035));
      const margin = Math.ceil(scale*.6+28);
      const filter = svgNode('filter',{
        id:`ct-liquid-${record.id}-v${++record.version}`,
        filterUnits:'userSpaceOnUse', primitiveUnits:'userSpaceOnUse',
        'color-interpolation-filters':'sRGB',
        x:-margin,y:-margin,width:width+2*margin,height:height+2*margin
      });
      filter.append(
        svgNode('feFlood',{'flood-color':'rgb(128,128,128)','flood-opacity':1,result:'mapBg'}),
        svgNode('feImage',{href:map,x:0,y:0,width,height,preserveAspectRatio:'none',result:'rawMap'}),
        svgNode('feComposite',{in:'rawMap',in2:'mapBg',operator:'over',result:'map'})
      );
      // Three low-dispersion passes bend the background; foreground text is untouched.
      const dispersion = .2;
      const channels = [
        ['R',1+DISPERSION_SPREAD*dispersion,'1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['G',1+DISPERSION_SPREAD*.5*dispersion,'0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0'],
        ['B',1,'0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0']
      ];
      for (const [name,ratio,matrix] of channels) {
        filter.append(
          svgNode('feDisplacementMap',{in:'SourceGraphic',in2:'map',scale:scale*ratio,xChannelSelector:'R',yChannelSelector:'G'}),
          svgNode('feColorMatrix',{type:'matrix',values:matrix,result:`refract${name}`})
        );
      }
      filter.append(
        svgNode('feComposite',{in:'refractR',in2:'refractG',operator:'arithmetic',k1:0,k2:1,k3:1,k4:0,result:'refractRG'}),
        svgNode('feComposite',{in:'refractRG',in2:'refractB',operator:'arithmetic',k1:0,k2:1,k3:1,k4:0,result:'lensOut'}),
        svgNode('feColorMatrix',{in:'map',type:'matrix',values:`0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 1 0 ${-128/255}`,result:'sheenMask'}),
        svgNode('feComposite',{in:'sheenMask',in2:'lensOut',operator:'arithmetic',k1:0,k2:.65,k3:1,k4:0})
      );
      if (record.filter) record.filter.replaceWith(filter); else defs.append(filter);
      record.filter = filter;
      record.key = key;
      const blur = element.classList.contains('orb-shell') ? 5 : element.tagName === 'DIALOG' ? 13 : 9;
      element.style.backdropFilter = `blur(${blur}px) saturate(1.18) url(#${filter.id})`;
      element.dataset.liquid = 'ready';
    } catch {
      // A failed optical layer must never hide controls or prevent task management.
      element.style.removeProperty('backdrop-filter');
      element.dataset.liquid = 'fallback';
      record?.filter?.remove();
      record?.generator?.dispose();
      records.delete(element);
    }
  }
  function schedule(element) {
    pending.add(element);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const element of pending) update(element);
      pending.clear();
    });
  }
  const observer = new ResizeObserver(entries => entries.forEach(entry=>schedule(entry.target)));
  function onPointerMove(event) {
    if (reduceMotion.matches) return;
    const element = event.target.closest?.('[data-liquid]');
    if (!element || !elements.includes(element)) return;
    pointer = {element, x:event.clientX, y:event.clientY};
    if (lightFrame) return;
    lightFrame = requestAnimationFrame(() => {
      lightFrame = 0;
      if (disposed || !pointer) return;
      const rect = pointer.element.getBoundingClientRect();
      pointer.element.style.setProperty('--light-x', `${pointer.x-rect.left}px`);
      pointer.element.style.setProperty('--light-y', `${pointer.y-rect.top}px`);
    });
  }
  for (const element of elements) {
    element.dataset.liquid = 'pending';
    observer.observe(element);
    schedule(element);
  }
  document.addEventListener('pointermove',onPointerMove,{passive:true});
  return () => {
    disposed = true; observer.disconnect();
    cancelAnimationFrame(frame); cancelAnimationFrame(lightFrame);
    document.removeEventListener('pointermove',onPointerMove);
    for (const record of records.values()) record.generator.dispose();
    records.clear(); defsRoot.remove();
    for (const element of elements) {element.style.removeProperty('backdrop-filter');delete element.dataset.liquid;}
  };
}

// Original native surface lighting: ease only a masked highlight, never text or
// external desktop pixels. One active surface and no idle JavaScript loop.
function initializeNativeLight(elements,selector) {
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let active=null, frame=0, disposed=false, x=0, y=0, targetX=0, targetY=0, lastTime=0;
  function reset(){cancelAnimationFrame(frame);frame=0;lastTime=0;if(active){active.style.removeProperty('--light-x');active.style.removeProperty('--light-y');active=null;}}
  function syncMotion(){document.documentElement.dataset.fluidMotion=!document.hidden&&!reduced.matches?'running':'paused';if(document.hidden||reduced.matches)reset();}
  function draw(time){
    frame=0;
    if(disposed||!active?.isConnected||document.hidden||reduced.matches){reset();return;}
    const dt=lastTime?Math.min(64,time-lastTime):16;lastTime=time;
    const ease=1-Math.exp(-dt/95);x+=(targetX-x)*ease;y+=(targetY-y)*ease;
    active.style.setProperty('--light-x',`${x.toFixed(1)}px`);active.style.setProperty('--light-y',`${y.toFixed(1)}px`);
    if(Math.abs(targetX-x)+Math.abs(targetY-y)>.15)frame=requestAnimationFrame(draw);else lastTime=0;
  }
  function move(event){
    if(disposed||document.hidden||reduced.matches||event.pointerType==='touch')return;
    const surface=event.target.closest?.(selector);
    if(!surface){reset();return;}
    const rect=surface.getBoundingClientRect();
    if(active!==surface){reset();active=surface;x=rect.width*.32;y=rect.height*.12;}
    targetX=Math.max(0,Math.min(rect.width,event.clientX-rect.left));targetY=Math.max(0,Math.min(rect.height,event.clientY-rect.top));
    if(!frame)frame=requestAnimationFrame(draw);
  }
  syncMotion();
  document.addEventListener('pointermove',move,{passive:true});document.addEventListener('pointerleave',reset);
  document.addEventListener('visibilitychange',syncMotion);reduced.addEventListener('change',syncMotion);window.addEventListener('blur',reset);
  return()=>{disposed=true;reset();document.removeEventListener('pointermove',move);document.removeEventListener('pointerleave',reset);document.removeEventListener('visibilitychange',syncMotion);reduced.removeEventListener('change',syncMotion);window.removeEventListener('blur',reset);delete document.documentElement.dataset.fluidMotion;for(const element of elements)delete element.dataset.liquid;};
}

