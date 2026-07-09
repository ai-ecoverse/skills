// speck — element-level annotation layer for local HTML pages
// Usage: speck inject <tabId> [--file <path>] | speck collect <tabId> | speck remove <tabId>

const exec = require('sliccy:exec');
const browser = require('sliccy:browser');

const args = process.argv.slice(2);
const command = args[0];
const tabId = args[1];

const isHelp = command === '--help' || command === '-h';
if (!command || isHelp || !tabId) {
  console.log(`speck — element annotation layer for local HTML pages

Usage:
  speck inject <tabId> [--file <path>]   Inject hover+input interaction (with live lick dispatch)
  speck collect <tabId>                  Retrieve submitted annotations as JSON
  speck remove <tabId>                   Remove the speck overlay from the page

Options:
  --file <path>    Path to the HTML file being annotated (enables AI-powered edits via licks)

The tabId is the CDP target ID for the tab (shown by 'serve').`);
  process.exit(isHelp ? 0 : 1);
}

// Parse --file flag
let filePath = null;
const fileIdx = args.indexOf('--file');
if (fileIdx !== -1 && args[fileIdx + 1]) {
  filePath = args[fileIdx + 1];
}

if (command === 'inject') {
  // Find or create a single webhook for speck (routes to speck-worker scoop)
  let webhookUrl = '';
  const listResult = await exec('webhook list');
  const existingMatch = listResult.stdout.match(/speck-lick\s+(https:\/\/\S+)/);
  
  if (existingMatch) {
    webhookUrl = existingMatch[1];
  } else {
    const webhookResult = await exec('webhook create --scoop speck-worker --name speck-lick');
    if (webhookResult.exitCode === 0) {
      const urlMatch = webhookResult.stdout.match(/URL:\s+(https:\/\/\S+)/);
      if (urlMatch) webhookUrl = urlMatch[1];
    }
  }

  if (!webhookUrl) {
    console.error('Failed to create or find speck webhook');
    process.exit(1);
  }

  const INJECT_SCRIPT = `(function(){if(document.getElementById('speck-style'))return 'already injected';var WEBHOOK_URL=${JSON.stringify(webhookUrl)};var FILE_PATH=${JSON.stringify(filePath || '')};var TAB_ID=${JSON.stringify(tabId)};var style=document.createElement('style');style.id='speck-style';style.textContent='#speck-highlight{position:fixed;top:0;left:0;width:0;height:0;border:2px solid oklch(60% 0.25 350);border-radius:3px;pointer-events:none;z-index:100001;box-sizing:border-box;display:none;opacity:0;transition:top 140ms cubic-bezier(0.22,1,0.36,1),left 140ms cubic-bezier(0.22,1,0.36,1),width 140ms cubic-bezier(0.22,1,0.36,1),height 140ms cubic-bezier(0.22,1,0.36,1),opacity 150ms ease}#speck-tag{position:fixed;background:oklch(15% 0.01 350);color:oklch(99% 0 0);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;font-weight:500;padding:2px 6px;border-radius:3px;z-index:100002;pointer-events:none;white-space:nowrap;display:none;letter-spacing:0.02em;transition:top 140ms cubic-bezier(0.22,1,0.36,1),left 140ms cubic-bezier(0.22,1,0.36,1),opacity 150ms ease}#speck-input-tooltip{position:fixed;z-index:100005;display:none;opacity:0;transform:translateY(6px);transition:opacity 0.25s cubic-bezier(0.22,1,0.36,1),transform 0.3s cubic-bezier(0.22,1,0.36,1);background:oklch(98% 0.005 350/0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid oklch(90% 0.01 350/0.6);border-radius:10px;box-shadow:0 8px 32px oklch(0% 0 0/0.12),0 2px 8px oklch(0% 0 0/0.08);font-family:system-ui,-apple-system,sans-serif;font-size:13px;color:oklch(15% 0.01 350);padding:6px 10px;min-width:300px;flex-direction:column;gap:6px}#speck-input-tooltip input{background:oklch(99% 0 0);border:1px solid oklch(90% 0.01 350/0.6);border-radius:6px;color:oklch(15% 0.01 350);font-family:system-ui,-apple-system,sans-serif;font-size:13px;padding:5px 10px;outline:none;width:100%;box-sizing:border-box;transition:border-color 0.15s ease,box-shadow 0.15s ease}#speck-input-tooltip input:focus{border-color:oklch(60% 0.25 350);box-shadow:0 0 0 3px oklch(60% 0.25 350/0.15)}#speck-input-tooltip input::placeholder{color:oklch(55% 0 0)}#speck-input-tooltip .speck-hint{color:oklch(55% 0 0);font-size:11px}@media(prefers-color-scheme:dark){#speck-input-tooltip{background:oklch(20% 0.01 350/0.92);border-color:oklch(35% 0.01 350/0.6);color:oklch(90% 0 0)}#speck-input-tooltip input{background:oklch(25% 0.01 350);border-color:oklch(40% 0.01 350/0.6);color:oklch(95% 0 0)}#speck-input-tooltip input::placeholder{color:oklch(55% 0 0)}#speck-input-tooltip .speck-hint{color:oklch(55% 0 0)}}';document.head.appendChild(style);var hi=document.createElement('div');hi.id='speck-highlight';document.body.appendChild(hi);var tag=document.createElement('div');tag.id='speck-tag';document.body.appendChild(tag);var tooltip=document.createElement('div');tooltip.id='speck-input-tooltip';var inp=document.createElement('input');inp.type='text';inp.placeholder='Improve this element...';var hint=document.createElement('span');hint.className='speck-hint';hint.textContent='Enter to apply \\u00b7 Esc to cancel';tooltip.appendChild(inp);tooltip.appendChild(hint);document.body.appendChild(tooltip);var current=null;var locked=false;var SKIP=new Set(['html','head','body','script','style','link','meta','noscript','br','wbr']);window.__speckElementInstructions=window.__speckElementInstructions||[];function desc(el){var t=el.tagName.toLowerCase();if(el.id)return t+'#'+el.id;if(el.className&&typeof el.className==='string'){var c=el.className.trim().split(/\\s+/).slice(0,2).join('.');if(c)return t+'.'+c;}return t;}function getSelector(el){if(el.id)return'#'+el.id;var path=[];var node=el;while(node&&node!==document.body){var t=node.tagName.toLowerCase();var parent=node.parentElement;if(parent){var siblings=Array.from(parent.children).filter(function(c){return c.tagName===node.tagName});if(siblings.length>1){var idx=siblings.indexOf(node)+1;t+=':nth-of-type('+idx+')';}}path.unshift(t);node=parent;}return path.join(' > ');}function showHighlight(el){if(!el)return;var r=el.getBoundingClientRect();var wasHidden=hi.style.display==='none'||hi.style.opacity==='0';if(wasHidden){hi.style.transition='none';hi.style.top=(r.top-2)+'px';hi.style.left=(r.left-2)+'px';hi.style.width=(r.width+4)+'px';hi.style.height=(r.height+4)+'px';hi.style.display='block';void hi.offsetWidth;hi.style.transition='';hi.style.opacity='1';}else{hi.style.top=(r.top-2)+'px';hi.style.left=(r.left-2)+'px';hi.style.width=(r.width+4)+'px';hi.style.height=(r.height+4)+'px';hi.style.opacity='1';hi.style.display='block';}var tipTop=r.top-20;var tipY=tipTop<4?r.bottom+4:tipTop;var tipX=r.left;if(tipX<4)tipX=4;tag.textContent=desc(el);tag.style.top=tipY+'px';tag.style.left=tipX+'px';tag.style.display='block';tag.style.opacity='1';}function hideHighlight(){hi.style.opacity='0';hi.style.display='none';tag.style.display='none';}function onMouseOver(e){if(locked)return;var el=e.target;if(el===document.body||el===document.documentElement||SKIP.has(el.tagName.toLowerCase()))return;if(tooltip.contains(el)||hi===el||tag===el)return;current=el;showHighlight(el);}function onMouseOut(e){if(locked)return;if(!tooltip.contains(e.relatedTarget)&&e.relatedTarget!==hi&&e.relatedTarget!==tag){hideHighlight();current=null;}}function onClick(e){if(tooltip.contains(e.target))return;e.preventDefault();e.stopPropagation();if(locked&&current){hideHighlight();tooltip.style.opacity='0';tooltip.style.transform='translateY(6px)';setTimeout(function(){tooltip.style.display='none';},250);locked=false;current=null;return;}if(!current)return;locked=true;showHighlight(current);var rect=current.getBoundingClientRect();var barH=60;var gap=8;var top=rect.bottom+gap;if(top+barH+gap>window.innerHeight)top=rect.top-barH-gap;if(top<gap)top=gap;var left=rect.left+(rect.width-320)/2;if(left<10)left=10;if(left+320>window.innerWidth-10)left=window.innerWidth-330;tooltip.style.top=top+'px';tooltip.style.left=left+'px';tooltip.style.display='flex';requestAnimationFrame(function(){tooltip.style.opacity='1';tooltip.style.transform='translateY(0)';});inp.value='';inp.focus();}function onKeyDown(e){if(e.key==='Enter'&&inp.value.trim()){var instruction=inp.value.trim();var elTag=current?current.tagName.toLowerCase():'?';var elClass=current?current.className:'';var elText=current?current.textContent.slice(0,80).trim():'';var selector=current?getSelector(current):'';var outerSnippet=current?current.outerHTML.slice(0,300):'';var annotation={instruction:instruction,element:{tag:elTag,class:elClass,text:elText,selector:selector,outerSnippet:outerSnippet},file:FILE_PATH,tabId:TAB_ID,timestamp:Date.now()};window.__speckElementInstructions.push(annotation);if(WEBHOOK_URL){fetch(WEBHOOK_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'element-instruction',data:annotation})}).catch(function(){});}inp.style.borderColor='oklch(65% 0.2 145)';inp.style.boxShadow='0 0 0 3px oklch(65% 0.2 145/0.15)';setTimeout(function(){tooltip.style.opacity='0';tooltip.style.transform='translateY(6px)';setTimeout(function(){tooltip.style.display='none';inp.style.borderColor='';inp.style.boxShadow='';},250);hideHighlight();locked=false;current=null;},350);}if(e.key==='Escape'){tooltip.style.opacity='0';tooltip.style.transform='translateY(6px)';setTimeout(function(){tooltip.style.display='none';},250);hideHighlight();locked=false;current=null;}}document.addEventListener('mouseover',onMouseOver);document.addEventListener('mouseout',onMouseOut);document.addEventListener('click',onClick,true);inp.addEventListener('keydown',onKeyDown);window.__speckCleanup=function(){document.removeEventListener('mouseover',onMouseOver);document.removeEventListener('mouseout',onMouseOut);document.removeEventListener('click',onClick,true);inp.removeEventListener('keydown',onKeyDown);hi.remove();tag.remove();tooltip.remove();style.remove();delete window.__speckCleanup;delete window.__speckElementInstructions;};return 'speck injected (lick-enabled)'})()`;

  let result;
  try {
    result = await browser.eval(tabId, INJECT_SCRIPT);
  } catch (e) {
    console.error('Failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
  console.log(String(result).trim());
  if (webhookUrl) {
    console.log('Lick-enabled: annotations route to cone for progress + execution');
    if (filePath) console.log(`File: ${filePath}`);
  }

} else if (command === 'collect') {
  const COLLECT_SCRIPT = `JSON.stringify(window.__speckElementInstructions||[])`;
  let result;
  try {
    result = await browser.eval(tabId, COLLECT_SCRIPT);
  } catch (e) {
    console.error('Failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
  console.log(String(result).trim());

} else if (command === 'remove') {
  const REMOVE_SCRIPT = `(function(){if(window.__speckCleanup){window.__speckCleanup();return 'speck removed'}return 'speck not found on this page'})()`;
  let result;
  try {
    result = await browser.eval(tabId, REMOVE_SCRIPT);
  } catch (e) {
    console.error('Failed:', e && e.message ? e.message : String(e));
    process.exit(1);
  }
  console.log(String(result).trim());

} else {
  console.error(`Unknown command: ${command}`);
  console.log('Valid commands: inject, collect, remove');
  process.exit(1);
}
