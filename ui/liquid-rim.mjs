// Surface reflection only: no page textures, screenshots, or desktop sampling.
// Layered edge/contour/center and circular-normal design informed by
// dashersw/liquid-glass-js, container.js, MIT, Copyright (c) 2025 Armagan Amcalar.
// Fixed source: 78cb6ccb0b9987bb60a88b14ccbd13a9e6e8ab2a.
// The shader below is a small, original reflection model; see THIRD-PARTY-NOTICES.md.
const DEVICE_PIXEL_LIMIT=256;
const FRAME_INTERVAL=1000/24;
const VERTEX_SHADER=`
attribute vec2 a_position;
varying vec2 v_position;
void main(){
  v_position=a_position;
  gl_Position=vec4(a_position,0.0,1.0);
}`;
const FRAGMENT_SHADER=`
precision mediump float;
varying vec2 v_position;
uniform vec2 u_resolution;
uniform vec2 u_pointer;
uniform float u_time;
void main(){
  vec2 p=v_position*u_resolution/min(u_resolution.x,u_resolution.y);
  float radius=length(p);
  vec2 normal=p/max(radius,0.0001);
  float angle=atan(normal.y,normal.x);
  float flow=sin(angle*3.0+u_time*0.27)*0.18
            +sin(angle*5.0-u_time*0.19)*0.07;
  float ripple=sin(angle*4.0+u_time*0.31)*0.025;
  normal=normalize(normal+vec2(-normal.y,normal.x)*ripple);
  float depth=max(1.0-radius,0.0);
  float edge=exp(-depth*66.0);
  float bevel=exp(-pow((depth-0.060-flow*0.016)/(0.046+flow*0.018),2.0));
  float shoulder=exp(-pow((depth-0.135)/0.075,2.0));
  vec2 light=normalize(vec2(-0.58,0.82)+u_pointer*0.19);
  float key=pow(max(dot(normal,light),0.0),8.0);
  float bounce=pow(max(dot(normal,normalize(vec2(0.66,-0.75))),0.0),13.0);
  float glint=edge*(0.15+key*0.26+bounce*0.12)
             +bevel*(0.035+key*0.67+bounce*0.29)*(0.94+flow*0.3)
             +shoulder*key*0.065;
  float shade=bevel*max(-normal.y,0.0)*0.065;
  float coverage=(1.0-smoothstep(0.986,1.0,radius))*smoothstep(0.62,0.82,radius);
  float alpha=clamp((glint+shade)*coverage,0.0,0.82);
  vec3 reflection=mix(vec3(0.86,0.93,0.98),vec3(1.0,0.985,0.95),key*0.65);
  vec3 color=(reflection*glint+vec3(0.24,0.36,0.43)*shade)/max(glint+shade,0.0001);
  // The transparent center never changes the existing glass-transparency setting.
  gl_FragColor=vec4(color*alpha,alpha);
}`;

/** Owns one decorative WebGL context. The returned diagnostics contain no GL handles. */
export function initializeLiquidRim(surface){
  const canvas=surface?.querySelector('.orb-rim');
  const reduced=matchMedia('(prefers-reduced-motion: reduce)');
  const listeners=new Set(),shaders=new Set();
  let gl=null,program=null,buffer=null,uniforms=null,observer=null;
  let status='initializing',reason=null,disposed=false,contextAttempts=0;
  let timer=0,frame=0,frames=0,lastDraw=-Infinity,previousTime=0,phase=0;
  let minimumFrameMs=Infinity,dirty=true,observingResize=false;
  let pointer=null,targetX=0,targetY=0,lightX=0,lightY=0;

  function listen(target,type,handler,options){
    target.addEventListener(type,handler,options);
    listeners.add({target,type,handler,options});
  }
  function unlisten(handler){
    for(const record of listeners)if(record.handler===handler){
      record.target.removeEventListener(record.type,record.handler,record.options);
      listeners.delete(record);
    }
  }
  function stop(){
    clearTimeout(timer);cancelAnimationFrame(frame);timer=0;frame=0;previousTime=0;
  }
  function detachRuntime(){
    observer?.disconnect();observer=null;observingResize=false;
    for(const handler of [onPointerMove,onPointerLeave,onResize])unlisten(handler);
    pointer=null;targetX=0;targetY=0;
  }
  function releaseGL(){
    if(!gl)return;
    try{
      for(const shader of shaders)gl.deleteShader(shader);
      if(buffer)gl.deleteBuffer(buffer);
      if(program)gl.deleteProgram(program);
      if(!gl.isContextLost())gl.getExtension('WEBGL_lose_context')?.loseContext();
    }catch{/* Context teardown is best effort; the canvas is already hidden. */}
    shaders.clear();buffer=null;program=null;uniforms=null;gl=null;
  }
  function cleanUp(){
    stop();detachRuntime();
    for(const record of listeners)record.target.removeEventListener(record.type,record.handler,record.options);
    listeners.clear();
    if(canvas){canvas.hidden=true;canvas.width=1;canvas.height=1;}
    surface?.style.removeProperty('--light-x');surface?.style.removeProperty('--light-y');
    releaseGL();
  }
  function fallback(code){
    status='fallback';reason=code;
    if(surface)surface.dataset.rim='fallback';
    cleanUp();
  }
  function dispose(){
    if(disposed)return;
    disposed=true;status='disposed';reason=null;
    if(surface)surface.dataset.rim='fallback';
    cleanUp();
  }
  const controller=Object.freeze({dispose,getDiagnostics:()=>Object.freeze({
    status,reason,disposed,frames,contextAttempts,sampledAt:performance.now(),
    width:canvas?.width||0,height:canvas?.height||0,
    scheduled:Boolean(timer||frame),listeners:listeners.size,observingResize,
    reducedMotion:reduced.matches,resourcesLive:shaders.size+Number(Boolean(program))+Number(Boolean(buffer)),
    minimumFrameMs:Number.isFinite(minimumFrameMs)?minimumFrameMs:null
  })});
  function failure(code){const error=new Error(code);error.code=code;return error;}
  function compile(type,source){
    const shader=gl.createShader(type);
    if(!shader)throw failure('shader-allocation');
    shaders.add(shader);gl.shaderSource(shader,source);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw failure('shader-compile');
    return shader;
  }
  function resize(){
    const width=Math.max(1,surface.clientWidth),height=Math.max(1,surface.clientHeight);
    const scale=Math.min(Math.max(1,window.devicePixelRatio||1),DEVICE_PIXEL_LIMIT/Math.max(width,height));
    const deviceWidth=Math.max(1,Math.min(DEVICE_PIXEL_LIMIT,Math.round(width*scale)));
    const deviceHeight=Math.max(1,Math.min(DEVICE_PIXEL_LIMIT,Math.round(height*scale)));
    if(canvas.width!==deviceWidth||canvas.height!==deviceHeight){
      canvas.width=deviceWidth;canvas.height=deviceHeight;
    }
    gl.viewport(0,0,canvas.width,canvas.height);
    gl.uniform2f(uniforms.resolution,canvas.width,canvas.height);dirty=false;
  }
  function requestFrame(){
    if(disposed||status!=='ready'||document.hidden||timer||frame)return;
    timer=setTimeout(()=>{timer=0;frame=requestAnimationFrame(draw);},Math.max(0,FRAME_INTERVAL-(performance.now()-lastDraw)));
  }
  function draw(time){
    frame=0;
    if(disposed||status!=='ready'||document.hidden)return;
    if(time-lastDraw<FRAME_INTERVAL){requestFrame();return;}
    try{
      if(gl.isContextLost()){fallback('context-lost');return;}
      if(dirty)resize();
      if(pointer&&!reduced.matches){
        const rect=surface.getBoundingClientRect();
        targetX=Math.max(-1,Math.min(1,(pointer.x-rect.left)/rect.width*2-1));
        targetY=Math.max(-1,Math.min(1,1-(pointer.y-rect.top)/rect.height*2));pointer=null;
      }
      const elapsed=previousTime?Math.min(80,time-previousTime)/1000:0;
      previousTime=time;
      if(!reduced.matches)phase+=elapsed;
      lightX+=(targetX-lightX)*0.22;lightY+=(targetY-lightY)*0.22;
      gl.uniform1f(uniforms.time,phase);gl.uniform2f(uniforms.pointer,lightX,lightY);
      gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      if(gl.getError()!==gl.NO_ERROR){fallback('render-failed');return;}
      surface.style.setProperty('--light-x',`${(28+lightX*15).toFixed(2)}%`);
      surface.style.setProperty('--light-y',`${(13-lightY*9).toFixed(2)}%`);
      if(Number.isFinite(lastDraw))minimumFrameMs=Math.min(minimumFrameMs,time-lastDraw);
      lastDraw=time;frames++;
      if(!reduced.matches)requestFrame();
    }catch{fallback('render-failed');}
  }
  function onResize(){dirty=true;requestFrame();}
  function onPointerMove(event){if(event.pointerType!=='touch')pointer={x:event.clientX,y:event.clientY};}
  function onPointerLeave(){pointer=null;targetX=0;targetY=0;}
  function attachRuntime(){
    listen(window,'resize',onResize,{passive:true});
    if(window.visualViewport)listen(window.visualViewport,'resize',onResize,{passive:true});
    if(typeof ResizeObserver==='function'){
      observer=new ResizeObserver(onResize);observer.observe(surface);observingResize=true;
    }
    if(!reduced.matches){
      listen(surface,'pointermove',onPointerMove,{passive:true});
      listen(surface,'pointerleave',onPointerLeave,{passive:true});
    }
  }
  function syncActivity(){
    if(disposed||status!=='ready')return;
    stop();detachRuntime();
    if(document.hidden)return;
    lightX=0;lightY=0;dirty=true;attachRuntime();
    requestFrame();
  }
  function onContextLost(event){event.preventDefault();fallback('context-lost');}

  if(!surface||!canvas){fallback('missing-canvas');return controller;}
  canvas.hidden=true;
  try{
    contextAttempts++;
    gl=canvas.getContext('webgl',{alpha:true,premultipliedAlpha:true,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:true,powerPreference:'low-power'});
    if(!gl){fallback('unavailable');return controller;}
    const vertex=compile(gl.VERTEX_SHADER,VERTEX_SHADER),fragment=compile(gl.FRAGMENT_SHADER,FRAGMENT_SHADER);
    program=gl.createProgram();if(!program)throw failure('program-allocation');
    gl.attachShader(program,vertex);gl.attachShader(program,fragment);gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw failure('shader-link');
    for(const shader of shaders){gl.detachShader(program,shader);gl.deleteShader(shader);}shaders.clear();
    gl.useProgram(program);buffer=gl.createBuffer();if(!buffer)throw failure('buffer-allocation');
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'a_position');
    gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    uniforms={resolution:gl.getUniformLocation(program,'u_resolution'),time:gl.getUniformLocation(program,'u_time'),pointer:gl.getUniformLocation(program,'u_pointer')};
    gl.clearColor(0,0,0,0);status='ready';surface.dataset.rim='ready';canvas.hidden=false;
    listen(canvas,'webglcontextlost',onContextLost);
    listen(document,'visibilitychange',syncActivity);listen(reduced,'change',syncActivity);
    listen(window,'pagehide',dispose,{once:true});syncActivity();
  }catch(error){fallback(error?.code||'initialization-failed');}
  return controller;
}
