// 在独立隐藏页面中运行；只传回有界候选 URL，不传回网页正文或脚本。
// 对齐旧版 XHR/fetch、媒体属性、Hls.loadSource 和脚本扫描，不执行抓取到的代码。
export const installCapture = String.raw`(()=>{
  if(globalThis.__javmStreamCapture)return;
  const urls=new Set(), scripts=new WeakMap(), hooked=new WeakSet();
  const maxText=65536;
  let textBudget=512*1024, responses=0, pending=0;
  const report=(raw,base=location.href,force=false)=>{
    if(typeof raw!=='string'||raw.length>8192||urls.size>=16)return;
    try{
      const url=new URL(raw,base);
      if(!/^https?:$/.test(url.protocol)||url.username||url.password)return;
      if(!force&&!/\.(?:m3u8|txt)$/i.test(url.pathname))return;
      url.hash=''; urls.add(url.href);
    }catch{}
  };
  const scan=(raw,base=location.href)=>{
    if(typeof raw!=='string'||textBudget<=0)return;
    const text=raw.slice(0,Math.min(maxText,textBudget))
      .replace(/\\(?:u002f|x2f|\/)/gi,'/').replace(/&amp;/g,'&');
    textBudget-=text.length;
    const pattern=/(?:https?:)?\/\/[^\s"'\x60<>\\)\]}]+|["'\x60]([^"'\x60<>\s\\]{1,8192})["'\x60]/g;
    let match, count=0;
    while(count++<256&&(match=pattern.exec(text)))report(match[1]||match[0],base);
  };
  const body=(text,url)=>{
    if(/^\s*#EXTM3U\b/.test(text.replace(/^\uFEFF/,'')))report(url,location.href,true);
    else scan(text,url);
  };
  const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(method,url){
    report(typeof url==='string'?url:String(url));
    return open.apply(this,arguments);
  };
  XMLHttpRequest.prototype.send=function(){
    this.addEventListener('load',()=>{
      if(responses>=16||textBudget<=0)return;
      try{
        if(this.responseType===''||this.responseType==='text'){
          responses++; body(this.responseText.slice(0,maxText),this.responseURL);
        }
      }catch{}
    },{once:true});
    return send.apply(this,arguments);
  };
  const fetch=globalThis.fetch;
  globalThis.fetch=function(input){
    report(typeof input==='string'?input:input?.url);
    const result=fetch.apply(this,arguments);
    void result.then(async response=>{
      if(responses>=16||pending>=2||textBudget<=0||
        !/mpegurl|text|json|javascript|octet-stream|^$/i.test(response.headers.get('content-type')||''))return;
      responses++; pending++;
      let reader;
      try{
        reader=response.clone().body?.getReader();
        if(!reader)return;
        const decoder=new TextDecoder(); let text='',bytes=0;
        while(bytes<maxText){
          const chunk=await reader.read();
          if(chunk.done)break;
          const part=chunk.value.subarray(0,maxText-bytes);
          bytes+=part.byteLength; text+=decoder.decode(part,{stream:true});
        }
        body(text+decoder.decode(),response.url);
      }finally{
        pending--;
        if(reader)void reader.cancel().catch(()=>{});
      }
    }).catch(()=>{});
    return result;
  };
  const attribute=Element.prototype.setAttribute;
  Element.prototype.setAttribute=function(name,value){
    if(/^(?:src|data-src)$/i.test(name))report(value);
    return attribute.apply(this,arguments);
  };
  for(const prototype of [HTMLMediaElement.prototype,HTMLSourceElement.prototype]){
    const descriptor=Object.getOwnPropertyDescriptor(prototype,'src');
    if(descriptor?.set&&descriptor.configurable)Object.defineProperty(prototype,'src',{
      ...descriptor,set(value){report(value);descriptor.set.call(this,value)}
    });
  }
  const hookHls=value=>{
    const prototype=value?.prototype;
    if(!prototype||typeof prototype.loadSource!=='function'||hooked.has(prototype))return;
    const load=prototype.loadSource;
    prototype.loadSource=function(url){report(url,location.href,true);return load.apply(this,arguments)};
    hooked.add(prototype);
  };
  try{
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'Hls');
    if(!descriptor||(descriptor.configurable&&descriptor.writable)){
      let hls=globalThis.Hls; hookHls(hls);
      Object.defineProperty(globalThis,'Hls',{
        configurable:true,enumerable:true,get:()=>hls,set(value){hls=value;hookHls(value)}
      });
    }else hookHls(globalThis.Hls);
  }catch{}
  const visible=element=>{
    const box=element.getBoundingClientRect();
    return box.width>0&&box.height>0&&element.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
  };
  globalThis.__javmStreamCapture={read(rule,challenged){
    if(challenged)return {};
    const missing=rule&&document.readyState==='complete'&&document.querySelector(rule.selector);
    if(missing&&(!rule.text||missing.textContent.includes(rule.text)))return {missing:true};
    const interaction=[...document.querySelectorAll('input[type="password"],input[name="captcha"],#challenge-form input[type="checkbox"]')]
      .slice(0,16).some(element=>!element.disabled&&!element.checked&&visible(element));
    for(const script of [...document.scripts].slice(0,64)){
      if(textBudget<=0)break;
      const text=script.textContent.slice(0,maxText);
      if(scripts.get(script)!==text){scripts.set(script,text);scan(text)}
    }
    for(const element of [...document.querySelectorAll('video,source,[data-src]')].slice(0,64)){
      report(element.currentSrc||element.src);
      report(element.getAttribute('data-src'));
    }
    try{hookHls(globalThis.Hls)}catch{}
    if(!interaction){
      for(const media of [...document.querySelectorAll('video,audio')].slice(0,8)){
        media.muted=true;if(media.paused)void media.play().catch(()=>{});
      }
      const play=document.querySelector('.plyr__control--overlaid,.vjs-big-play-button,.jw-display-icon-container');
      if(play&&!play.dataset.javmTried){play.dataset.javmTried='1';play.click()}
    }
    return {urls:[...urls],pageUrl:location.href.slice(0,8192),interaction};
  }};
})()`;
