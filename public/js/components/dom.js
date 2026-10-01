// Tiny DOM builder shared by every component. Keeps components declarative
// without a framework: `el('div', { class: 'p-4' }, [child])`.
//
// `text` always goes through textContent, never innerHTML, so user data (a
// username from the platform token) can never inject markup. `html` exists
// only for the rare caller that passes trusted, hand-written markup.
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'disabled') node.disabled = true;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.appendChild(
      typeof child === 'string' ? document.createTextNode(child) : child,
    );
  }
  return node;
}
