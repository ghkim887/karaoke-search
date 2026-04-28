// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App.js';

describe('App loading state', () => {
  let host: HTMLElement;

  afterEach(() => {
    if (host?.parentNode) host.parentNode.removeChild(host);
  });

  it('renders the build-time record count and a 3-dot animation slot', () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    render(<App />, host);
    const loading = host.querySelector('.loading');
    expect(loading).not.toBeNull();
    // The literal record count (currently 26,401) appears in the text.
    expect(loading?.textContent).toMatch(/26,401곡 검색 인덱스 빌드 중/);
    expect(loading?.textContent).toMatch(/Building 26,401-song index/);
    // Three loading-dot spans inside the loading paragraph.
    expect(loading?.querySelectorAll('.loading-dot').length).toBe(3);
  });
});
