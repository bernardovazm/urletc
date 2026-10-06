"""E2E: urletc console. Mount, launcher (hover/grid/reorder), generators,
TTS, collapsible cards + sidebar groups, feed deletion (mouse plus real taps in a touch
context), the visual-viewport keyboard inset, code chip, theme, connect modal,
every text tool driven with real input, and the service worker precache install."""
import base64
import hashlib
import io
import json
import os
import re
import sys
import tempfile
from playwright.sync_api import sync_playwright

# Overridable so the suite isn't pinned to one host/path (see scripts/e2e.sh, CI).
BASE = os.environ.get('E2E_BASE', 'http://localhost:5199')
SNAP = os.environ.get('E2E_SNAP', '/tmp')
passed, failed = [], []


def check(name, cond, extra=''):
    (passed if cond else failed).append(f'{name}{": " + extra if extra and not cond else ""}')
    print(('PASS' if cond else 'FAIL'), name, extra if not cond else '')


# Unique code room per run. A fixed literal lets a concurrent run of this suite, or a
# stray tab on the same network, join the same room; the "0 peers" assertions then see
# real peers and fail intermittently. Section 2b closes the other half of that hole.
OWN_CODE = 'e2e' + os.urandom(3).hex()
# The code typed into the composer in 13j: six characters of the generated-code alphabet
# with a digit, the only shape the composer auto-joins. Random for the same reason as
# OWN_CODE. CI runs each push to main in parallel, and with a fixed literal every
# concurrent run met in one room, where one run's camera arrived as a tile in another
# run's page. The alphabet is parsed from discovery.ts so the two cannot drift apart.
CODE_ALPHABET = re.search(r"const CODE_ALPHABET = '([a-z0-9]+)'", io.open(
    os.path.join(os.path.dirname(__file__), '..', 'src', 'p2p', 'discovery.ts'), encoding='utf-8').read()).group(1)
TYPED_CODE = 'q7' + ''.join(CODE_ALPHABET[b % len(CODE_ALPHABET)] for b in os.urandom(4))


def tool_ids():
    """Every registered tool id, parsed from src/tools/index.ts.

    Parsed rather than hardcoded so a newly registered tool is covered automatically. A
    hardcoded list drifts and quietly drops tools out of the suite.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'tools', 'index.ts'), encoding='utf-8').read()
    ids = re.findall(r"^\s*id: '([a-z0-9-]+)',", src, re.M)
    assert len(ids) >= 15, f'expected the full tool registry, parsed only {ids}'
    return ids


def tool_id_for(module):
    """The registered id of the tool whose `load:` imports `module`.

    Resolved from source because ids get renamed: a stale literal would leave the tool
    untested while the run still passed.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'tools', 'index.ts'), encoding='utf-8').read()
    for block in re.findall(r'registry\.register\(\{(.*?)\n  \}\)', src, re.S):
        if f"import('./{module}')" in block:
            m = re.search(r"id: '([a-z0-9-]+)'", block)
            if m:
                return m.group(1)
    raise AssertionError(f'no registered tool loads ./{module}')


# Third-party relays flap, so a handful of lines is tolerated. Above this the relay list
# itself is at fault: a set that refuses announces logged around 80 lines in 60s, one per
# refused announce, with discovery dead the whole time.
RELAY_NOISE_BUDGET = 12


def relay_hosts():
    """Relay hosts the app dials, parsed from src/p2p/session.ts.

    Parsed from source for the same reason as tool_ids(): a hardcoded copy drifts away
    from the list it is meant to guard.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'p2p', 'session.ts'), encoding='utf-8').read()
    decl = re.search(r'const NOSTR_RELAYS = \[(.*?)\]', src, re.S)
    assert decl, 'could not find NOSTR_RELAYS in src/p2p/session.ts'
    hosts = re.findall(r"wss://([^'\"\s]+)", decl.group(1))
    assert hosts, 'parsed no relay hosts from NOSTR_RELAYS'
    return hosts


def presence_invite_offers():
    """How many times an unanswered "?p=1" invite is re-offered, parsed from console.ts.

    Parsed rather than hardcoded so raising or lowering the cap moves this assertion with
    it instead of leaving a stale number that no longer describes the policy.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'shell', 'console.ts'), encoding='utf-8').read()
    m = re.search(r'const PRESENCE_INVITE_OFFERS = (\d+)', src)
    assert m, 'could not find PRESENCE_INVITE_OFFERS in src/shell/console.ts'
    return int(m.group(1))


def nickname_lists():
    """The adjective and noun lists a default device name is drawn from, parsed from
    src/core/nickname.ts.

    Parsed rather than hardcoded for the same reason as tool_ids(): a second copy of the
    lists here would drift, and these assertions would stop describing the scheme that
    actually ships.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'core', 'nickname.ts'), encoding='utf-8').read()
    lists = []
    for const in ('ADJECTIVES', 'NOUNS'):
        m = re.search(r'const ' + const + r' = \[(.*?)\n\]', src, re.S)
        assert m, f'could not find {const} in src/core/nickname.ts'
        words = re.findall(r"'([a-z]+)'", m.group(1))
        assert len(words) >= 16, f'{const} parsed as {words}'
        lists.append(words)
    return lists


# Page visibility, driven from the page. Headless Chromium reports every tab as visible:
# bring_to_front() changes nothing there and Emulation.setPageVisibilityOverride is gone
# from the protocol, so there is no way to make the browser itself background a tab. What
# is replaced here is exactly what the app reads (document.visibilityState) and what it
# listens for (visibilitychange), so the shipped code path is the one exercised; the only
# thing outside this harness is the browser's own decision to call a tab hidden.
VISIBILITY = """
  let hiddenNow = false
  Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (hiddenNow ? 'hidden' : 'visible') })
  Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => hiddenNow })
  window.__background = (on) => { hiddenNow = !!on; document.dispatchEvent(new Event('visibilitychange')) }
"""


def title_count(pg):
    """Events the title is reporting, 0 when it carries no mark. Reads the count out of
    the "(N) name" prefix, so it also asserts the mark is a prefix: a suffix would be the
    first thing a tab strip clips."""
    m = re.match(r'^\((\d+)\+?\) ', pg.title())
    return int(m.group(1)) if m else 0


def icon_href(pg):
    return pg.evaluate("() => document.querySelector('link[rel=icon]').getAttribute('href')")


# A real rendered-text PNG pasted as a file. A stub with only a valid PNG signature
# fails in libpng before OCR runs, so it cannot tell a working pipeline from a dead one.
# Shared by the proactive-OCR block and the clipboard block so both drive the same
# known-readable image.
PASTE_IMAGE_JS = '''async () => {
  const c = document.createElement('canvas'); c.width = 520; c.height = 140
  const g = c.getContext('2d')
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
  g.fillStyle = '#000'; g.font = 'bold 76px Georgia, serif'; g.textBaseline = 'middle'
  g.fillText('Hello urletc', 18, 74)
  const blob = await new Promise(r => c.toBlob(r, 'image/png'))
  const dt = new DataTransfer()
  dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
  document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
}'''


def ocr_settle(page, pre, tries=45):
    """The recognised text once it stops being a progress line.

    The same <pre> carries progress ("Reading...", "Recognizing... 62%") before the
    result, so waiting for non-empty text captures a progress string. Fetching language
    data is slower against a live deployment than a local preview, hence the budget.
    """
    t = ''
    for _ in range(tries):
        page.wait_for_timeout(1000)
        t = (pre.inner_text() or '').strip()
        if t and '%' not in t and not t.lower().startswith(('reading', 'recognizing', 'loading', 'initial')):
            return t
    return t


def cpf_valid(s):
    d = [int(c) for c in re.sub(r'\D', '', s)]
    if len(d) != 11:
        return False
    for r in (9, 10):
        sm = sum(v * (r + 1 - i) for i, v in enumerate(d[:r]))
        dv = (sm * 10) % 11
        if (0 if dv == 10 else dv) != d[r]:
            return False
    return True


def clip_after(pg, want, seconds=5):
    """The clipboard text once it equals `want` (or satisfies it, when `want` is a
    predicate), else the last read after `seconds`. Copy handlers call writeText without
    awaiting it, so one read straight after the click can still see the previous text."""
    ok = want if callable(want) else (lambda t: t == want)
    t = ''
    for _ in range(int(seconds / 0.25)):
        t = pg.evaluate('navigator.clipboard.readText()')
        if ok(t):
            return t
        pg.wait_for_timeout(250)
    return t


with sync_playwright() as p:
    # Fake mic/cam so getUserMedia flows (captions offer, device check) run headless.
    browser = p.chromium.launch(headless=True, args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'])
    ctx = browser.new_context(permissions=['clipboard-read', 'clipboard-write', 'microphone', 'camera'])
    page = ctx.new_page()
    logs = []
    page.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    page.on('pageerror', lambda e: logs.append(f'pageerror: {e}'))
    page.on('dialog', lambda d: d.accept())

    page.goto(BASE)
    page.wait_for_selector('.composer', timeout=20000)
    page.wait_for_timeout(1500)

    # --- 1. mount / shell ---
    # inner_text() returns rendered text, so it reflects text-transform. Assert the DOM
    # text and the presentation separately rather than coupling them.
    check('brand mounted', page.locator('.topbar .brand').text_content() == 'urletc')
    check('brand uses the tracked uppercase treatment',
          page.eval_on_selector('.topbar .brand',
                                "e => getComputedStyle(e).textTransform") == 'uppercase')
    check('composer visible', page.locator('.composer textarea').is_visible())
    # The CSP sets require-trusted-types-for 'script', which makes the Worker constructor
    # a TrustedScriptURL sink. With no default policy installed every worker throws, and
    # OCR, speech to text, live captions and the regex engine all die while the rest of
    # the UI keeps rendering. Assert the mechanism, not the rendering.
    check('Trusted Types default policy installed',
          page.evaluate('!!(window.trustedTypes && window.trustedTypes.defaultPolicy)'))
    check('same-origin module Worker can be constructed',
          page.evaluate("() => { try { new Worker(new URL('/assets/nope.js', location.origin), {type:'module'}).terminate(); return true } catch (e) { return String(e.message) } }") is True)
    check('blob Worker can be constructed (tesseract builds these)',
          page.evaluate("() => { try { const u = URL.createObjectURL(new Blob(['self.close()'],{type:'text/javascript'})); new Worker(u).terminate(); return true } catch (e) { return String(e.message) } }") is True)
    cb = page.locator('.composer').bounding_box()
    vp = page.viewport_size
    check('composer inside viewport', cb and cb['y'] + cb['height'] <= vp['height'] + 1)
    check('no page errors on boot', not any('pageerror' in l for l in logs), '; '.join(l for l in logs if 'pageerror' in l)[:300])

    # --- 2. tooltips ---
    titles = page.eval_on_selector_all('.composer .bar button', 'els => els.map(e => e.title)')
    check('composer buttons have tooltips', all(t for t in titles), str(titles))

    # --- 2b. hermetic runs: another urletc behind this public IP (a stray tab, another
    # checkout) connects over Nearby and turns the "0 peers" queue tests into real sends.
    # Switch Nearby off through its own control. ---
    page.evaluate("location.hash = '#/t/settings'")
    stn = page.locator('details.card').last
    nbl = stn.locator('label', has_text='Nearby discovery')
    # Settings appends its controls only after six store reads, on a chunk loaded cold here.
    try:
        nbl.first.wait_for(state='attached', timeout=10000)
    except Exception:
        pass
    nb_present = nbl.count() == 1
    check('settings: nearby toggle present', nb_present)
    if nb_present:
        nbx = nbl.locator('input[type=checkbox]')
        check('settings: nearby on by default', nbx.is_checked())
        nbx.uncheck()
        page.wait_for_timeout(600)
    page.evaluate("location.hash = ''")
    page.wait_for_timeout(400)

    # --- 3. code chip (auto join-code) ---
    try:
        page.wait_for_selector('button.code-chip:not(.hidden)', timeout=15000)
        code_text = page.locator('button.code-chip').inner_text().strip()
        check('code chip shows auto-generated code', re.fullmatch(r'[2-9A-Z]{6}', code_text) is not None, code_text)
        page.locator('button.code-chip').click()
        clip = clip_after(page, lambda t: t.upper() == code_text)
        check('code chip click copies code', clip.upper() == code_text, clip)
    except Exception as e:
        check('code chip shows auto-generated code', False, str(e)[:200])

    # --- 4. theme, driven from Settings ---
    # Settings is the only theme entry point now, so drive that control. Assert on the
    # painted background rather than the data-theme attribute, and assert the choice
    # survives a reload; a rendered <select> proves neither.
    check('topbar no longer carries a theme button',
          page.locator('.topbar button[title*="black and white"]').count() == 0)
    body_dark = page.eval_on_selector('body', 'e => getComputedStyle(e).backgroundColor')
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    thsel = page.locator('details.card').last.locator('select.theme-select')
    check('settings: theme control present', thsel.count() == 1, f'{thsel.count()} matches')
    check('settings: theme control opens on the theme in force', thsel.input_value() == 'dark', thsel.input_value())
    thsel.select_option('light')
    page.wait_for_timeout(300)
    body_light = page.eval_on_selector('body', 'e => getComputedStyle(e).backgroundColor')
    check('theme switches to light from Settings', page.evaluate('document.documentElement.dataset.theme') == 'light')
    check('the light theme is actually painted', body_light != body_dark, f'dark={body_dark} light={body_light}')
    check('the light choice is persisted', page.evaluate("localStorage.getItem('wt-theme')") == 'light')
    page.evaluate("location.hash = ''")
    page.wait_for_timeout(300)
    # Boot opens the Clipboard tool card when the permission is granted and the clipboard
    # holds something, and this context copied to it two blocks ago. Blank it so a reload
    # here is testing what this block is about.
    page.evaluate("() => navigator.clipboard.writeText(' ')")
    page.reload()
    page.wait_for_selector('.composer', timeout=20000)
    page.wait_for_timeout(800)
    check('the light theme survives a reload',
          page.evaluate('document.documentElement.dataset.theme') == 'light'
          and page.eval_on_selector('body', 'e => getComputedStyle(e).backgroundColor') == body_light)
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    thsel2 = page.locator('details.card').last.locator('select.theme-select')
    check('settings reopens showing the theme in force', thsel2.input_value() == 'light', thsel2.input_value())
    thsel2.select_option('dark')
    page.wait_for_timeout(300)
    check('theme switches back to dark from Settings',
          page.evaluate('document.documentElement.dataset.theme') == 'dark'
          and page.eval_on_selector('body', 'e => getComputedStyle(e).backgroundColor') == body_dark)
    page.evaluate("location.hash = ''")
    page.wait_for_timeout(300)

    # --- 5. tool launcher: hover to open, grid, no scroll ---
    tools_btn = page.locator('.topbar button', has_text='Tools')
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    n_tools = page.locator('.menu.tool-grid button.tool-open').count()
    check('launcher opens on hover', n_tools >= 15, f'{n_tools} tools')
    no_scroll = page.eval_on_selector('.menu.tool-grid', 'e => e.scrollHeight <= e.clientHeight + 1')
    check('launcher not scrollable', no_scroll)
    first_before = page.locator('.menu.tool-grid button.tool-open').first.inner_text()
    page.screenshot(path=f'{SNAP}/e2e-launcher.png')

    # --- 6. drag-to-reorder persists ---
    # Share screen leads the list and is not a tool, so it takes no part in the order.
    DRAGGABLE = '.menu.tool-grid button.tool-open[draggable="true"]'
    first_before = page.locator(DRAGGABLE).first.inner_text()
    src = page.locator(DRAGGABLE).nth(2)
    dst = page.locator(DRAGGABLE).nth(0)
    moved_name = src.inner_text()
    src.drag_to(dst)
    page.wait_for_timeout(400)
    first_after = page.locator(DRAGGABLE).first.inner_text()
    check('drag reorders tool list', first_after == moved_name and first_after != first_before, f'{first_before!r} -> {first_after!r}')
    page.keyboard.press('Escape')
    page.mouse.click(400, 300)  # close launcher
    page.wait_for_timeout(300)
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    check('reorder persists on reopen', page.locator(DRAGGABLE).first.inner_text() == moved_name)

    # --- 6b. Generators hover preview: values flyout beside launcher, click-to-copy ---
    page.locator('.menu.tool-grid button', has_text='Generators').hover()
    page.wait_for_selector('.gen-flyout .gen-row', timeout=6000)
    fly_rows = page.locator('.gen-flyout .gen-row').count()
    check('hover preview lists values', fly_rows >= 10, f'{fly_rows} rows')
    fv = page.locator('.gen-flyout button.gen-value').first
    fval = fv.inner_text()
    fv.click()
    check('hover-preview value click copies', clip_after(page, fval) == fval, fval[:24])

    # --- 7. generators tool: instant values + one-click copy ---
    page.locator('.menu.tool-grid button', has_text='Generators').click()
    try:
        page.wait_for_selector('.gen-row', timeout=10000)
    except Exception:
        print('DEBUG cards:', page.locator('details.card').count())
        if page.locator('details.card').count():
            print('DEBUG last card:', page.locator('details.card').last.inner_text()[:300])
        print('DEBUG menu still open:', page.locator('.menu.tool-grid').count())
        print('DEBUG recent logs:', *logs[-8:], sep='\n  ')
        import urllib.request
        try:
            print('DEBUG server alive:', urllib.request.urlopen('http://localhost:5199/', timeout=3).status)
        except Exception as se:
            print('DEBUG server DEAD:', se)
        page.screenshot(path=f'{SNAP}/e2e-gen-fail.png')
        raise
    gen = page.locator('details.card').last
    n_rows = page.locator('.gen-row').count()
    check('generators renders rows instantly', n_rows >= 10, f'{n_rows} rows')
    # Default region follows the browser locale; Playwright defaults to en-US, so United States.
    check('locale default region en-US gives US: SSN shown',
          page.locator('.gen-row', has=page.locator('.gen-label', has_text=re.compile('^SSN$'))).count() == 1)
    check('locale default region: no CPF for en-US',
          page.locator('.gen-row', has=page.locator('.gen-label', has_text=re.compile('^CPF$'))).count() == 0)
    check('Name row present', page.locator('.gen-row', has=page.locator('.gen-label', has_text=re.compile('^Name$'))).count() == 1)
    # Switch to Brazil to expose CPF and verify its check digits + copy + regenerate.
    gen.locator('select').select_option('br')
    page.wait_for_timeout(300)
    cpf_row = page.locator('.gen-row', has=page.locator('.gen-label', has_text=re.compile('^CPF$')))
    check('Brazil region exposes CPF', cpf_row.count() == 1)
    cpf_val = cpf_row.locator('button.gen-value').inner_text()
    check('CPF has valid check digits', cpf_valid(cpf_val), cpf_val)
    cpf_row.locator('button.gen-value').click()
    check('one click copies CPF', clip_after(page, cpf_val) == cpf_val)
    cpf_row.locator('button[title^="New"]').click()
    new_val = cpf_row.locator('button.gen-value').inner_text()
    check('regenerate produces new valid CPF', new_val != cpf_val and cpf_valid(new_val), new_val)
    check('no standalone Generate button in topbar', page.locator('.topbar button', has_text='Generate').count() == 0)
    page.screenshot(path=f'{SNAP}/e2e-generators.png')

    # --- 8. collapsible card ---
    card = page.locator('details.card').last
    check('tool card is open by default', card.evaluate('e => e.open'))
    card.locator('summary').click()
    check('card collapses on summary click', not card.evaluate('e => e.open'))
    card.locator('summary').click()
    check('card re-expands', card.evaluate('e => e.open'))
    # The per-tool copy-link button was removed: on a phone it sat on top of the card's
    # own delete control, and shared history already carries a tool to the other device.
    # Deep links are unaffected and are asserted further down.
    link_btns = page.locator('button[aria-label="Copy a direct link to this tool"]').count()
    check('no per-tool copy-link button on a tool card', link_btns == 0, f'{link_btns} still rendered')

    # --- 9. feed item deletion: arms on the first click, deletes on the second ---
    # The negative assertion is the load-bearing one: a single click must leave the item
    # alone. Asserting only that two clicks delete would also pass if the first click
    # deleted and the second hit nothing.
    items_before = page.locator('.feed-item').count()
    wrap = page.locator('.feed-item').last
    wrap.hover()
    dele = wrap.locator('button.del')
    dele.click()
    check('delete: one click does not remove the item',
          page.locator('.feed-item').count() == items_before,
          f'{page.locator(".feed-item").count()} items, was {items_before}')
    check('delete: the first click arms the control',
          'armed' in (dele.get_attribute('class') or ''), dele.get_attribute('class') or '')
    check('delete: the armed state carries aria-label and aria-pressed, not colour alone',
          'confirm' in (dele.get_attribute('aria-label') or '').lower()
          and dele.get_attribute('aria-pressed') == 'true',
          f'{dele.get_attribute("aria-label")!r} pressed={dele.get_attribute("aria-pressed")!r}')
    dele.click()
    check('delete: the second click removes the item', page.locator('.feed-item').count() == items_before - 1,
          f'{page.locator(".feed-item").count()} items, was {items_before}')

    # An armed control must not stay armed. Leaving the button disarms it, so a stray
    # click on it minutes later re-arms instead of deleting.
    items_before = page.locator('.feed-item').count()
    wrap = page.locator('.feed-item').last
    wrap.hover()
    dele = wrap.locator('button.del')
    dele.click()
    page.mouse.move(4, 4)  # pointerleave
    page.wait_for_timeout(200)
    check('delete: moving the pointer away disarms the control',
          'armed' not in (dele.get_attribute('class') or '')
          and dele.get_attribute('aria-pressed') == 'false',
          f'{dele.get_attribute("class")!r} pressed={dele.get_attribute("aria-pressed")!r}')
    wrap.hover()
    dele.click()
    check('delete: a click after disarming re-arms without deleting',
          page.locator('.feed-item').count() == items_before,
          f'{page.locator(".feed-item").count()} items, was {items_before}')
    page.mouse.move(4, 4)
    page.wait_for_timeout(200)

    # --- 10. text-utils auto-copy on transform ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Text Utilities').click()
    tu = page.locator('details.card').last
    tu.locator('textarea').fill('hello world')
    tu.locator('button', has_text='UPPER').click()
    page.wait_for_timeout(400)
    check('transform shows result', tu.locator('pre').inner_text() == 'HELLO WORLD')
    check('transform auto-copies', clip_after(page, 'HELLO WORLD') == 'HELLO WORLD')

    # --- 11. TTS voices UI ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Text to Speech').click()
    tts = page.locator('details.card').last
    if tts.locator('p.muted').count() and 'not supported' in tts.locator('p.muted').first.inner_text():
        check('TTS guidance when unsupported', True)
    else:
        note = tts.locator('div.muted.small').last.inner_text()
        check('TTS explains voice availability', len(note) > 10, note)
        check('TTS has cloud-voices opt-in', tts.locator('input[type=checkbox]').count() == 1)

    # --- 11b. hash tool: multi-algorithm, known digests, auto re-hash on algo change ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text=re.compile(r'\bHash\b')).click()
    hx = page.locator('details.card').last
    hx.locator('textarea').fill('abc')
    hx.locator('button', has_text='Hash text').click()
    page.wait_for_timeout(300)
    sha256_abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    sha1_abc = 'a9993e364706816aba3e25717850c26c9cd0d89d'
    check('hash: SHA-256(abc)', hx.locator('pre').inner_text().strip() == sha256_abc, hx.locator('pre').inner_text().strip()[:24])
    hx.locator('select').select_option('SHA-1')
    page.wait_for_timeout(300)
    check('hash: re-computes on algorithm change to SHA-1(abc)', hx.locator('pre').inner_text().strip() == sha1_abc, hx.locator('pre').inner_text().strip()[:24])

    # --- 11c. diff tool: one add + one remove ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Diff').click()
    df = page.locator('details.card').last
    df.locator('textarea').nth(0).fill('one\ntwo\nthree')
    df.locator('textarea').nth(1).fill('one\nTWO\nthree')
    df.locator('button', has_text='Diff').click()
    page.wait_for_timeout(300)
    n_add, n_del = df.locator('.diff-add').count(), df.locator('.diff-del').count()
    check('diff: marks one add + one remove', n_add == 1 and n_del == 1, f'add={n_add} del={n_del}')

    # --- 11d. timestamp tool: epoch 0 becomes the 1970 ISO string ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Timestamp').click()
    ep = page.locator('details.card').last
    ep.locator('input.mono-input').fill('0')
    page.wait_for_timeout(200)
    iso = ep.locator('.gen-row', has=page.locator('.gen-label', has_text='ISO 8601')).locator('.gen-value').inner_text()
    check('timestamp: epoch 0 becomes 1970 ISO', iso.startswith('1970-01-01T00:00:00'), iso)

    # --- 11e. pong tool (P2P PoC): board canvas present + opponent lobby renders ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Pong').click()
    pong = page.locator('details.card').last
    try:
        pong.locator('canvas.pong').wait_for(state='attached', timeout=10000)  # hidden until a match
    except Exception:
        pass
    check('pong has a board canvas', pong.locator('canvas.pong').count() == 1)
    lob = pong.locator('.pong-lobby')
    check('pong shows the opponent lobby', lob.count() == 1 and 'opponent' in lob.inner_text().lower(), (lob.inner_text()[:60] if lob.count() else 'no lobby'))

    # --- 11f. html-strip: real HTML in, plain text out ---
    # DOMParser.parseFromString is a TrustedHTML sink, so stripHtml() throws under
    # require-trusted-types-for while the card still mounts and looks fine. Mounting is
    # not exercising: this block clicks the button and reads the output.
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text=re.compile('HTML')).first.click()
    hs = page.locator('details.card').last
    hs_before = len(logs)
    # The script and style payloads are deliberate: textContent includes the source of
    # those elements, so a naive implementation strips this to "...hereSNEAKYCSSLEAK".
    # The style attributes are the style-src sink: Chromium evaluates the directive against
    # the inert document DOMParser builds, so each one logs a CSP violation unless the
    # attribute is renamed before parsing. The third paragraph carries the literal text
    # style="keep", which must survive, since a rewrite that is not confined to tag spans
    # corrupts body copy.
    hs.locator('textarea').fill(
        '<div style="color:ATTRLEAK"><h1>Title</h1>'
        '<p style=\'margin:0\'>Body <b>text</b> here.</p>'
        '<p>Write style="keep" to set it.</p>'
        '<script>var SNEAKY=1</script><style>.x{color:CSSLEAK}</style></div>')
    hs.locator('button', has_text='Strip to text').click()
    page.wait_for_timeout(400)
    hs_out = hs.locator('pre').inner_text().strip()
    check('html-strip: markup gone, text kept',
          all(w in hs_out for w in ('Title', 'Body', 'text', 'here')) and '<' not in hs_out and '>' not in hs_out,
          hs_out[:120])
    check('html-strip: script and style source do not leak into the text',
          'SNEAKY' not in hs_out and 'CSSLEAK' not in hs_out, hs_out[:120])
    check('html-strip: output is not the untouched placeholder',
          hs_out not in ('plain text output', '(empty)'), hs_out[:60])
    check('html-strip: style attribute values do not leak into the text',
          'ATTRLEAK' not in hs_out and 'margin' not in hs_out, hs_out[:120])
    check('html-strip: literal style= in body copy survives',
          'style="keep"' in hs_out, hs_out[:120])
    # The sink error reads "This document requires 'TrustedHTML' assignment", which
    # matches neither 'trustedscript' nor 'trusted type', so the run-wide filters below
    # miss it. Match that string class at the call site too.
    hs_tt = [l for l in logs[hs_before:] if 'trustedhtml' in l.lower()]
    check('html-strip: no TrustedHTML sink violation on strip', not hs_tt, ' | '.join(hs_tt[:2])[:200])
    # The run-wide filter below also catches this, but scoping it here names the sink that
    # fired instead of reporting a violation from somewhere in a 2000-line run.
    hs_csp = [l for l in logs[hs_before:] if 'content security policy' in l.lower()]
    check('html-strip: style attributes do not reach the style-src sink', not hs_csp,
          ' | '.join(hs_csp[:2])[:200])

    # --- 12. sidebar groups collapsible (sidebar starts collapsed, so open it first) ---
    page.locator('.topbar button[title*="devices & people"]').click()
    page.wait_for_timeout(200)
    n_groups = page.locator('.sidebar details.pgroup').count()
    check('sidebar has tier groups', n_groups >= 1, f'{n_groups} groups')
    if n_groups:
        g = page.locator('.sidebar details.pgroup').first
        g.locator('summary').click()
        check('sidebar group collapses', not g.evaluate('e => e.open'))
        g.locator('summary').click()
    page.locator('.topbar button[title*="devices & people"]').click()
    page.wait_for_timeout(200)

    # --- 13. connect modal: code (random + user-defined), pair link, reset ---
    page.locator('.topbar button', has_text='Connect').click()
    page.wait_for_selector('.modal', timeout=3000)
    modal = page.locator('.modal')
    # modal content builds async (pairing section awaits crypto.subtle before the
    # Nearby/Before-a-call blocks append), so wait for the last sections, not the shell
    page.wait_for_selector('.modal .group-label:has-text("Nearby")', timeout=3000)
    check('modal: nearby section', modal.locator('.group-label', has_text='Nearby').count() == 1,
          ' | '.join(modal.locator('.group-label').all_inner_texts()))
    check('modal: pair link field', modal.locator('input[readonly]').count() == 1)
    check('modal: reset link option', modal.locator('button', has_text='Reset link').count() == 1)
    mtxt = modal.inner_text()
    mlow = mtxt.lower()  # group labels render uppercase (CSS text-transform); inner_text returns rendered text
    check('modal: join-someone comes before share-your-code', 0 <= mlow.find('join someone') < mlow.find('or have them join you'), mtxt[:120])
    check('modal: invite link button', modal.locator('button', has_text='Copy invite link').count() == 1)
    check('modal: device-check shortcut', modal.locator('button', has_text='Test mic & camera').count() == 1)

    # random regenerate (old code stops working)
    big_before = modal.locator('.code-big').inner_text() if modal.locator('.code-big').count() else ''
    modal.locator('button', has_text='Random code').click()
    page.wait_for_timeout(1200)
    big_after = page.locator('.modal .code-big').inner_text() if page.locator('.modal .code-big').count() else ''
    check('modal: Random code regenerates', bool(big_after) and big_after != big_before, f'{big_before!r}->{big_after!r}')
    check('code chip follows new code', page.locator('button.code-chip').inner_text().strip().lower() == big_after.lower())

    # user-defined code: mixed case + punctuation normalizes to [a-z0-9]. Derived from
    # OWN_CODE so the room stays unique per run while still exercising normalization
    # (upper case, a dash and a trailing bang all have to be stripped).
    page.locator('.modal input.mono-input').fill(f'{OWN_CODE[:3].upper()}-{OWN_CODE[3:].upper()}!')
    page.locator('.modal button[title^="Connect with whoever uses this code"]').click()
    page.wait_for_timeout(1200)
    custom = page.locator('.modal .code-big').inner_text().strip().lower()
    check('user can define own code', custom == OWN_CODE, custom)
    check('chip shows custom code', page.locator('button.code-chip').inner_text().strip().lower() == OWN_CODE)
    page.screenshot(path=f'{SNAP}/e2e-connect.png')
    page.keyboard.press('Escape')
    page.mouse.click(10, 300)

    # --- 13b. the chosen code survives a full reload ---
    # Boot opens the Clipboard tool card when the permission is granted and the clipboard
    # holds something, and this context has copied to it several times by now. Blank it so
    # the reload below only exercises code persistence.
    page.evaluate("() => navigator.clipboard.writeText(' ')")
    page.reload()
    page.wait_for_selector('.composer', timeout=20000)
    page.wait_for_selector('button.code-chip:not(.hidden)', timeout=15000)
    reloaded = page.locator('button.code-chip').inner_text().strip().lower()
    check('code persists across reload', reloaded == OWN_CODE, reloaded)

    # --- 13c. flyout hover grace: values reachable across sibling items ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Generators').hover()
    page.wait_for_selector('.gen-flyout .gen-row', timeout=6000)
    page.locator('.menu.tool-grid button', has_text='Text Utilities').hover()  # cross a sibling
    page.wait_for_timeout(200)
    check('flyout survives crossing a sibling item', page.locator('.gen-flyout').count() == 1)
    page.locator('.gen-flyout').hover()
    page.wait_for_timeout(700)
    check('flyout stays while hovered', page.locator('.gen-flyout').count() == 1)
    page.mouse.move(640, 650)  # over the composer, safely outside both menu and flyout
    try:
        page.wait_for_selector('.gen-flyout', state='detached', timeout=4000)
    except Exception:
        pass
    check('flyout closes after leaving', page.locator('.gen-flyout').count() == 0)

    # --- 13d. modal paste guard + device name field ---
    page.locator('.topbar button', has_text='Connect').click()
    page.wait_for_selector('.modal', timeout=3000)
    items_before = page.locator('.feed-item').count()
    page.locator('.modal input.mono-input').click()
    page.evaluate('''() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'k4mn2x99')
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }''')
    page.wait_for_timeout(400)
    check('modal paste does not leak to the feed', page.locator('.feed-item').count() == items_before)
    nm = page.locator('.modal input[placeholder*="Device name"]')
    check('modal has device-name field', nm.count() == 1)
    # The default name is generated, so assert the properties the rest of the app relies
    # on rather than the one sample: the words come from the shipped lists, the avatar
    # initial exists, the roster never truncates it, and it is never the 'peer' sentinel
    # senderLabel() reads as "no name".
    adjectives, nouns = nickname_lists()
    nm_val = nm.input_value() or ''
    parts = nm_val.split('-')
    check('default name is adjective-noun-NN from the shipped word lists',
          len(parts) == 3 and parts[0] in adjectives and parts[1] in nouns and re.fullmatch(r'\d{2}', parts[2]) is not None, nm_val)
    check('default name starts with a letter, so the roster avatar has an initial',
          re.match(r'[A-Za-z]', nm_val) is not None and all(w[:1].isalpha() for w in adjectives + nouns), nm_val)
    check('default name is not the "peer" sentinel', nm_val != 'peer', nm_val)
    worst = max(len(a) for a in adjectives) + max(len(n) for n in nouns) + len('--NN')
    check('every name the scheme can mint clears the roster truncation (24) and MAX_NAME_CHARS (32)',
          worst <= 24 and 0 < len(nm_val) <= 24, f'worst case {worst}, this one {len(nm_val)}: {nm_val}')
    check('the name space is big enough that one room rarely collides',
          len(adjectives) * len(nouns) * 100 >= 100000, f'{len(adjectives)} x {len(nouns)} x 100')
    check('no corny copy in modal', 'keep it secret' not in page.locator('.modal').inner_text().lower())
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # --- 13d2. a device that already has a name keeps it; only a nameless one is minted ---
    # Seeded through the app's own control because the vault is encrypted at rest: a value
    # written straight into IndexedDB would be a blob the store cannot decrypt. The seed
    # uses words outside both lists, so a re-mint on boot cannot reproduce it by chance.
    SEEDED_NAME = 'stored-alias-99'
    page.locator('.topbar button', has_text='Connect').click()
    page.wait_for_selector('.modal', timeout=3000)
    seed_field = page.locator('.modal input[placeholder*="Device name"]')
    seed_field.fill(SEEDED_NAME)
    seed_field.dispatch_event('change')
    page.wait_for_timeout(300)
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    page.evaluate("() => navigator.clipboard.writeText(' ')")
    page.reload()
    page.wait_for_selector('.composer', timeout=20000)
    page.locator('.topbar button', has_text='Connect').click()
    page.wait_for_selector('.modal', timeout=3000)
    kept = page.locator('.modal input[placeholder*="Device name"]').input_value() or ''
    check('a stored device name survives a reload instead of being re-minted', kept == SEEDED_NAME, kept)
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # --- 13e. offline queue: sending with no peers keeps + queues the message ---
    me_before = page.locator('.msg.me').count()
    page.locator('.composer textarea').fill('queued hello')
    page.locator('.composer textarea').press('Enter')
    page.wait_for_timeout(300)
    check('own bubble rendered whether or not anyone is connected', page.locator('.msg.me').count() == me_before + 1)
    # The nearby tier is "same public IP", so a second run on this machine is a reachable
    # device and sending, not queueing, is then correct. Read the app's own connection
    # state and assert the behaviour that belongs to it. Neither branch is a skip:
    # connected must send, unconnected must queue.
    connected_now = 'connected' in (page.locator('.topbar .badge').first.inner_text() or '')
    if connected_now:
        check('with a device connected the message is sent rather than queued',
              page.locator('.toast', has_text='queued').count() == 0,
              'queued while a device was reachable')
    else:
        check('with no device connected the message is queued, and says so',
              page.locator('.toast', has_text='queued').count() >= 1,
              'no queued toast and no connected device')
    check('message has hover timestamp', bool(page.locator('.msg.me').last.get_attribute('title')))

    # --- 13f. sidebar: starts collapsed, single Connect entry point, no status noise ---
    check('no "looking for devices" noise', 'looking for devices' not in page.locator('.topbar').inner_text())
    check('sidebar starts collapsed', not page.locator('.sidebar').is_visible())
    page.locator('.topbar button[title*="devices & people"]').click()
    page.wait_for_timeout(200)
    check('sidebar opens via topbar toggle', page.locator('.sidebar.open').count() == 1 and page.locator('.sidebar').is_visible())
    check('no duplicate Connect in sidebar', page.locator('.sidebar button', has_text='Connect').count() == 0)
    page.locator('.topbar button[title*="devices & people"]').click()
    page.wait_for_timeout(200)
    check('sidebar collapses again', not page.locator('.sidebar').is_visible())

    # --- 13g. image paste makes a preview card with an always-available send button ---
    page.locator('.composer textarea').click()  # composer focus must not block image paste
    cards_before = page.locator('.feed-item').count()
    page.evaluate(PASTE_IMAGE_JS)
    try:
        page.wait_for_function('n => document.querySelectorAll(".feed-item").length > n', arg=cards_before,
                               timeout=10000)
    except Exception:
        pass
    check('image paste creates a card', page.locator('.feed-item').count() == cards_before + 1)
    # Located by content rather than by feed position. Playwright locators re-resolve on
    # every use and this feed is live, so a peer connecting mid-block appends a sys line
    # and a bare `.last` then points at that line instead, leaving the OCR assertion below
    # waiting 30s for a <pre> inside a system message. Filtering to cards that hold an
    # image preview keeps the block on its own card however many peers arrive.
    last_card = page.locator('.feed-item').filter(has=page.locator('img.preview')).last
    check('image card has preview', last_card.locator('img.preview').count() == 1)
    sendbtn = last_card.locator('button', has_text='Send to devices')
    check('send button is offered whether or not anyone is connected', sendbtn.count() == 1)
    sendbtn.click()
    page.wait_for_timeout(600)
    # Same non-hermetic nearby tier as above, so the assertion is that the button never
    # goes silent: it either reports where the file went or reports that there was nowhere
    # to send it. An unhandled rejection, which a peer dropping mid-file produces, shows
    # up here as neither.
    toasts = page.locator('.toast').all_inner_texts()
    check('sending a file always answers, with a destination or with "no one connected"',
          any('No one connected' in t or 'Sending to' in t or 'Could not send' in t for t in toasts),
          str(toasts)[:200] or 'no toast at all')
    # Proactive OCR, default "copy": no manual button, the output area is revealed at once.
    pre = last_card.locator('pre')
    check('proactive OCR replaces manual button', last_card.locator('button', has_text='Run OCR').count() == 0)
    check('proactive OCR output area revealed', pre.count() == 1 and 'hidden' not in (pre.get_attribute('class') or ''))
    # The pasted image carries real rendered text, so reading it back exercises the whole
    # pipeline: worker construction under Trusted Types, WASM core load, and recognition.
    # A card that merely rendered would pass with OCR completely dead.
    ocr_text = ocr_settle(page, pre)
    check('OCR worker starts under Trusted Types',
          'TrustedScriptURL' not in ocr_text and 'Failed to construct' not in ocr_text, ocr_text[:160])
    check('OCR actually reads the pasted image', 'urletc' in ocr_text.lower(), ocr_text[:160])
    # The mode is still the default 'copy', which has to mean the system clipboard rather
    # than a button on the card. The clipboard held 'HELLO WORLD' from the transform tool
    # until now, so finding the OCR text here is a real transition.
    check('OCR auto-copy actually writes the recognised text to the clipboard',
          'urletc' in page.evaluate('navigator.clipboard.readText()').lower(),
          repr(page.evaluate('navigator.clipboard.readText()')[:80]))

    # --- 13h. locale drives the default generator region, pt-BR gives Brazil ---
    ctx2 = browser.new_context(locale='pt-BR')
    pg2 = ctx2.new_page()
    pg2.goto(f'{BASE}/#/t/generators')
    pg2.wait_for_selector('.gen-row', timeout=20000)
    check('pt-BR locale defaults region to Brazil', pg2.locator('details.card select').input_value() == 'br')
    check('pt-BR default exposes CPF', pg2.locator('.gen-row', has=pg2.locator('.gen-label', has_text=re.compile('^CPF$'))).count() == 1)
    check('fresh profile: sidebar collapsed by default', not pg2.locator('.sidebar').is_visible())
    ctx2.close()

    # --- 13i. invite link: copying it lets another page land in the same room ---
    page.locator('.topbar button', has_text='Connect').click()
    page.wait_for_selector('.modal', timeout=3000)
    page.locator('.modal button', has_text='Copy invite link').click()
    invite = clip_after(page, lambda t: t.startswith(BASE) and f'#/join/{OWN_CODE}' in t)
    check('invite link format (#/join/<code>)', invite.startswith(BASE) and f'#/join/{OWN_CODE}' in invite, invite)
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)
    pg3 = ctx.new_page()
    pg3.goto(invite)
    pg3.wait_for_selector('.composer', timeout=20000)
    try:
        pg3.wait_for_function(
            f"() => (document.querySelector('button.code-chip')?.textContent || '').trim().toLowerCase() === '{OWN_CODE}'",
            timeout=20000)
        check('invite link auto-joins the room', True)
    except Exception:
        chip3 = pg3.locator('button.code-chip').inner_text() if pg3.locator('button.code-chip').count() else 'no chip'
        check('invite link auto-joins the room', False, chip3)
    pg3.close()

    # --- 13i2. online-list invite (?p=1): a question that survives a reload ---
    # A "?p=1" invite link says the sender is on the online list. Joining it makes a device
    # visible to every other user, so the link may only ask. The first syncCodeUrl() rewrites
    # the address bar from this device's own state and drops the flag, so the pending question
    # has to be stored: without that, a reload throws the invitation away in silence.
    def presence_box(pg):
        return pg.locator('label', has_text='Go online').locator('input[type=checkbox]')

    # Its own code room, so these contexts never become peers of the main page.
    PRES_CODE = 'p' + os.urandom(3).hex()
    pctx = browser.new_context()
    ppg = pctx.new_page()
    ppg.goto(f'{BASE}/#/join/{PRES_CODE}?p=1')
    ppg.wait_for_selector('.composer', timeout=20000)
    try:
        ppg.wait_for_selector('.presence-offer', timeout=15000)
    except Exception:
        pass
    check('?p=1 asks whether to join the online list', ppg.locator('.presence-offer').count() == 1)
    check('?p=1 does not join the online list on its own', not presence_box(ppg).is_checked())
    ppg.reload()
    ppg.wait_for_selector('.composer', timeout=20000)
    try:
        ppg.wait_for_selector('.presence-offer', timeout=15000)
    except Exception:
        pass
    check('the online-list invite is re-offered after a reload',
          ppg.locator('.presence-offer').count() == 1, ppg.evaluate('location.hash'))
    check('the re-offered invite still has not joined the online list', not presence_box(ppg).is_checked())
    # The chromeless stage route returns before the presence bootstrap, so an OBS browser
    # source neither raises the question nor spends one of the offers behind it. Its own
    # page, because a goto that only changes the hash never remounts, and the chromeless
    # assertion guards against that: without it a page that stayed on the console route
    # would report a clean pass.
    spg = pctx.new_page()
    spg.goto(f'{BASE}/#/stage/{PRES_CODE}')
    spg.wait_for_selector('.app-shell', timeout=20000)
    spg.wait_for_timeout(1500)
    check('the stage route entered chromeless mode',
          spg.evaluate("document.documentElement.classList.contains('stage-view')"))
    check('the stage route never offers the online list', spg.locator('.presence-offer').count() == 0)
    spg.close()
    # A page opened at the plain #/join URL: nothing in this address bar says "?p=1", so an
    # offer here can only have come out of storage. syncCodeUrl strips the flag on its own
    # schedule (it waits on the code-room join), so asserting on the address bar instead
    # would be asserting on relay timing.
    ppg.close()
    ppg = pctx.new_page()
    ppg.goto(f'{BASE}/#/join/{PRES_CODE}')
    ppg.wait_for_selector('.composer', timeout=20000)
    try:
        ppg.wait_for_selector('.presence-offer', timeout=15000)
    except Exception:
        pass
    check('the pending invite is offered on a URL that never carried ?p=1',
          ppg.locator('.presence-offer').count() == 1, ppg.evaluate('location.hash'))
    _accept = ppg.locator('.presence-offer button', has_text='Turn it on')
    check('the online-list invite can be accepted', _accept.count() == 1)
    if _accept.count():
        _accept.click()
        ppg.wait_for_timeout(500)
        check('accepting the invite turns the online list on', presence_box(ppg).is_checked())
        ppg.reload()
        ppg.wait_for_selector('.composer', timeout=20000)
        ppg.wait_for_timeout(2500)
        check('an accepted invite is not offered again', ppg.locator('.presence-offer').count() == 0)
        check('an accepted invite leaves the online list on', presence_box(ppg).is_checked())
    pctx.close()

    # Declining is final too: the question is recorded as closed, so no reload re-asks.
    dctx = browser.new_context()
    dpg = dctx.new_page()
    dpg.goto(f'{BASE}/#/join/{PRES_CODE}?p=1')
    dpg.wait_for_selector('.composer', timeout=20000)
    try:
        dpg.wait_for_selector('.presence-offer', timeout=15000)
    except Exception:
        pass
    _declined = dpg.locator('.presence-offer button', has_text='Not now')
    check('the online-list invite can be declined', _declined.count() == 1)
    if _declined.count():
        _declined.click()
        dpg.wait_for_timeout(300)
        dpg.reload()
        dpg.wait_for_selector('.composer', timeout=20000)
        dpg.wait_for_timeout(2500)
        check('a declined invite is not offered again', dpg.locator('.presence-offer').count() == 0)
        check('declining leaves the online list off', not presence_box(dpg).is_checked())
    dctx.close()

    # Ignoring it is bounded: the invite is raised a fixed number of times and then drops, so
    # an invitation nobody answers cannot become a prompt on every visit. Each pass opens the
    # ?p=1 link again rather than reloading, because that is the case the budget has to hold
    # against: the flag is still in the address bar when the app mounts (syncCodeUrl only
    # strips it once the code room is joined), and a mount that re-armed on it would ask
    # forever.
    offers = presence_invite_offers()
    ictx = browser.new_context()
    seen = []
    for i in range(offers + 1):
        ipg = ictx.new_page()
        ipg.goto(f'{BASE}/#/join/{PRES_CODE}?p=1')
        ipg.wait_for_selector('.composer', timeout=20000)
        # The spent offer is written down before the offer renders, so a read that beats the
        # render still uses one up. The last pass looks for an absence, which needs a wait.
        if i < offers:
            try:
                ipg.wait_for_selector('.presence-offer', timeout=15000)
            except Exception:
                pass
        else:
            ipg.wait_for_timeout(2500)
        seen.append(ipg.locator('.presence-offer').count())
        ipg.close()
    check(f'reopening an ignored ?p=1 link asks {offers} times and then stops',
          seen == [1] * offers + [0], str(seen))
    ictx.close()

    # --- 13j. composer: typing a join code connects ---
    # The placeholder names the field and does not explain join codes; the 🔗 share
    # button in the topbar is the discovery path. Assert the behaviour and that the
    # placeholder stayed short, rather than pinning any particular wording.
    ph = page.locator('.composer textarea').get_attribute('placeholder') or ''
    check('placeholder names the field without a lecture', 0 < len(ph) <= 48 and 'join code' not in ph, ph)
    page.locator('.composer textarea').fill(TYPED_CODE)
    page.locator('.composer textarea').press('Enter')
    try:
        page.wait_for_function(
            "c => (document.querySelector('button.code-chip')?.textContent || '').trim() === c",
            arg=TYPED_CODE.upper(), timeout=20000)
        check('typed join code connects', True)
    except Exception:
        check('typed join code connects', False, page.locator('button.code-chip').inner_text())
    check('auto-join announced in feed', page.locator('.sys', has_text='is a join code').count() >= 1)

    # --- 13k. mic share: live captions offered once (opt-in, on-device) ---
    page.locator('.composer .bar button[title^="Share your microphone"]').click()
    try:
        page.wait_for_selector('.sys button', timeout=10000)
        check('mic share offers live captions', page.locator('.sys button', has_text='Turn on live captions').count() == 1)
    except Exception:
        check('mic share offers live captions', False, 'no offer card appeared')
    check('captions stay off until opted in', not page.locator('.captions').is_visible())
    # The captions strip is collapsible (minimize keeps transcribing) as well as
    # dismissable. Both controls are wired while the strip is hidden, since opt-in gates
    # the Whisper worker, which headless cannot run.
    check('captions have a minimize (collapse) control', page.locator('.captions button[title*="Minimize"]').count() == 1)
    check('captions have a separate off control', page.locator('.captions button[title*="Turn captions off"]').count() == 1)
    # Present only if the share above started; a missing button would wait out the default
    # timeout and abort the run before the summary.
    _stop = page.locator('.composer .bar button[title*="Stop sharing"]')
    if _stop.count():
        _stop.click()
    page.wait_for_timeout(300)

    # --- 13k2. video tiles region is collapsible (streams keep running) ---
    check('tiles region hidden when nothing is shared', not page.locator('.tiles-region').is_visible())
    check('mute/blank toggles stay hidden until something is published',
          not page.locator('.composer .bar button[title*="Mute your microphone"]').is_visible()
          and not page.locator('.composer .bar button[title*="your camera o"]').is_visible())
    page.locator('.composer .bar button[title^="Share your camera"]').click()
    try:
        page.wait_for_selector('.tiles .stage-tile', timeout=10000)
        check('sharing camera shows a video tile', page.locator('.tiles .stage-tile').count() >= 1)
        check('tiles region now visible', page.locator('.tiles-region').is_visible())
        # Only a screen share expands the stage. A camera doing it too would hide the feed
        # every time anyone turned a webcam on.
        check('a camera share leaves the stage at its usual size',
              not page.evaluate("document.documentElement.classList.contains('stage-max')"))
        tcol = page.locator('.tiles-head button[title*="Collapse"]')
        check('tiles region has a collapse toggle', tcol.count() == 1)
        # stage controls live in the head row, next to the source count
        check('stage head reports a source count',
              'source' in page.locator('.tiles-head .muted').inner_text())
        # the layouts are single glyphs (a 28px icon button cannot hold a word), so the
        # word lives in the tooltip / accessible name and that is what is asserted
        check('stage head offers the three layouts',
              page.locator('.tiles-head button[title^="Grid:"]').count() == 1
              and page.locator('.tiles-head button[title^="Focus:"]').count() == 1
              and page.locator('.tiles-head button[title^="Solo:"]').count() == 1)
        exp = page.locator('.tiles-head button[title*="Expand the stage"]')
        check('stage has an expand-to-window toggle', exp.count() == 1)
        exp.click()
        page.wait_for_timeout(200)
        check('expanding the stage hides the feed',
              page.evaluate("document.documentElement.classList.contains('stage-max')")
              and not page.locator('.feed').is_visible())
        page.locator('.tiles-head button[title*="Shrink the stage"]').click()
        page.wait_for_timeout(200)
        check('shrinking the stage restores the feed', page.locator('.feed').is_visible())
        # a live camera exposes a blank-camera toggle that flips track.enabled
        cam_mute = page.locator('.composer .bar button[title="Turn your camera off"]')
        check('sharing camera reveals a camera-off toggle', cam_mute.count() == 1)
        cam_mute.click()
        page.wait_for_timeout(150)
        check('camera-off disables the track, it does not stop it',
              page.evaluate("!!document.querySelector('video.tile')") )
        check('camera-off toggle flips to on', page.locator('.composer .bar button[title="Turn your camera on"]').count() == 1)
        page.locator('.composer .bar button[title="Turn your camera on"]').click()
        page.wait_for_timeout(150)
        # a peer tile double-click affordance is advertised in the fullscreen control
        check('tile fullscreen control is labelled per source',
              page.locator('.stage-tile button[title^="Fullscreen "]').count() >= 1)
        tcol.click()
        page.wait_for_timeout(200)
        check('collapsing hides the tiles grid', not page.locator('.tiles').is_visible())
        check('but the stream keeps running (tile still in DOM)', page.locator('.tiles .stage-tile').count() >= 1)
        tcol.click()
        page.wait_for_timeout(200)
        check('expanding shows the tiles grid again', page.locator('.tiles').is_visible())
    except Exception as e:
        check('sharing camera shows a video tile', False, str(e)[:160])
    _stop = page.locator('.composer .bar button[title*="Stop sharing"]')
    if _stop.count():
        _stop.click()
    # Poll instead of sleeping a fixed 300ms. A loaded runner still had the region on screen
    # when the check ran, which failed a run for timing rather than for behaviour. This still
    # fails if the region never hides, it just stops calling a slow teardown a broken one.
    hidden = False
    for _ in range(50):
        if not page.locator('.tiles-region').is_visible():
            hidden = True
            break
        page.wait_for_timeout(100)
    check('stopping share hides the tiles region again', hidden)

    # --- 13k3. close guard: live media arms it, independently of the stored preference ---
    # beforeunload cannot be observed from Playwright, so close-guard.ts mirrors its
    # arming decision on <html data-close-guard>; a real camera share drives the publish
    # and unpublish paths under it.
    def guard_armed():
        return page.evaluate("document.documentElement.dataset.closeGuard") == 'on'

    def set_ask_on_close(on):
        """Flip the preference through the Settings checkbox, the only control for it."""
        page.evaluate("location.hash = '#/t/settings'")
        page.wait_for_selector('details.card[data-tool="settings"] input[type=checkbox]', timeout=10000)
        page.wait_for_timeout(300)
        box = page.locator('details.card[data-tool="settings"]').last.locator('label', has_text='Ask when closing tab').locator('input[type=checkbox]')
        if box.is_checked() != on:
            box.click()
            page.wait_for_timeout(300)

    set_ask_on_close(False)
    check('close guard: off with no share and the preference off', not guard_armed())
    page.locator('.composer .bar button[title^="Share your camera"]').click()
    try:
        page.wait_for_selector('.tiles .stage-tile', timeout=10000)
        check('close guard: a live share arms it while the preference is off', guard_armed())
        set_ask_on_close(True)
        check('close guard: armed with the preference on while sharing', guard_armed())
        set_ask_on_close(False)
        check('close guard: turning the preference off mid-share keeps it armed', guard_armed())
        set_ask_on_close(True)
    except Exception as e:
        check('close guard: a live share arms it while the preference is off', False, str(e)[:160])
    _stop = page.locator('.composer .bar button[title*="Stop sharing"]')
    if _stop.count():
        _stop.click()
    page.wait_for_timeout(400)
    check('close guard: stopping the share keeps it armed for the preference', guard_armed())
    set_ask_on_close(False)  # restore the default, so later pages do not boot guarded
    check('close guard: disarms with nothing live and the preference off', not guard_armed())

    # --- 13l. device check tool: live preview + meter with fake devices ---
    page.evaluate("location.hash = '#/t/device-check'")
    page.wait_for_timeout(500)
    dc = page.locator('details.card').last
    check('device check renders', 'Device Check' in dc.locator('summary').inner_text())
    dc.locator('button', has_text='Start test').click()
    live = False
    for _ in range(30):
        if 'Live.' in dc.inner_text():
            live = True
            break
        page.wait_for_timeout(500)
    check('device check goes live (fake devices)', live, dc.inner_text()[:140])
    check('level meter present', dc.locator('.meter').count() == 1)
    check('self-view video visible', dc.locator('video.preview').is_visible())
    check('speaker test available', dc.locator('button', has_text='Test speakers').count() == 1)
    dc.locator('button', has_text='Stop').first.click()
    page.wait_for_timeout(300)
    check('device check stops cleanly', 'Stopped' in dc.inner_text())

    # --- 13m. settings: proactivity controls, persisted ---
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    st = page.locator('details.card').last
    check('settings: OCR default is auto-copy',
          st.locator('select.ocr-select').input_value() == 'copy', st.locator('select.ocr-select').input_value())
    check('settings: captions toggle present', st.locator('input[type=checkbox]').count() >= 1)
    # The presence ("online list") tier announces you to everyone else, so unlike nearby
    # it must be opt-in, start off, and NEVER carry traffic.
    pr = st.locator('label', has_text='Online list').locator('input[type=checkbox]')
    check('settings: online-list toggle present', pr.count() == 1)
    check('settings: online list is opt-in (off by default)', not pr.is_checked())
    check('settings: online list is described as presence-only',
          'no messages, files or media' in st.locator('label', has_text='Online list').inner_text().lower())
    check('roster shows no online-list group while opted out',
          page.locator('.pgroup summary', has_text='Online now').count() == 0)
    st.locator('select.ocr-select').select_option('off')
    page.wait_for_timeout(300)
    page.evaluate("location.hash = '#/t/base64'")
    page.wait_for_timeout(300)
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    st2 = page.locator('details.card').last
    check('settings: OCR mode persists', st2.locator('select.ocr-select').input_value() == 'off')
    st2.locator('select.ocr-select').select_option('copy')  # restore the default for reruns
    page.wait_for_timeout(200)

    # ============ tools driven with real inputs: regressions ============
    # poll() is defined further down, beside the file-transfer contexts, so this section
    # carries a copy bound to the page it waits on.
    def rpoll(pg, fn, seconds, step=0.25):
        for _ in range(int(seconds / step)):
            v = fn()
            if v:
                return v
            pg.wait_for_timeout(int(step * 1000))
        return None

    def rf_open(perms=()):
        """A fresh context in a code room of its own, so no other run's peer joins it."""
        c = browser.new_context(permissions=list(perms))
        pg = c.new_page()
        pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
        pg.wait_for_selector('.composer', timeout=20000)
        return c, pg

    # An open Clipboard card leaves a paste aimed at a text field to that field, and still
    # takes one made with nothing editable focused. Its listener is document-wide and the
    # card opens by itself once clipboard-read is granted.
    rc, rp = rf_open(['clipboard-read', 'clipboard-write'])
    # The console opens a Clipboard card by itself when the clipboard already holds
    # something, so the card this deep link opens is the last one, not the only one.
    rp.evaluate("location.hash = '#/t/clipboard'")
    rcb = rp.locator('details.card[data-tool="clipboard"]').last
    rcb.locator('button', has_text='Scan clipboard').wait_for(timeout=10000)
    rp.evaluate("navigator.clipboard.writeText('plain words to paste')")
    rta = rp.locator('.composer textarea')
    rta.click()
    rp.keyboard.press('Control+V')
    check('clipboard card open: Ctrl+V into the composer inserts the text',
          bool(rpoll(rp, lambda: rta.input_value() == 'plain words to paste', 5)), repr(rta.input_value()))
    rta.fill('')
    rp.evaluate('document.activeElement.blur()')
    rp.evaluate("navigator.clipboard.writeText('card words arrive')")
    rp.keyboard.press('Control+V')
    check('clipboard card open: a paste with no field focused lands in the card',
          bool(rpoll(rp, lambda: 'card words arrive' in rcb.inner_text(), 5)), rcb.inner_text()[-160:])
    rc.close()

    # Workshop script and HTML-app tiers run. A blob: guest inherited the host CSP, whose
    # script-src refused the guest's inline bootstrap, so every script timed out after 30 s
    # and every app rendered an empty frame. Drive both tiers to their output.
    rc, rp = rf_open()
    rlogs = []
    rp.on('console', lambda m: rlogs.append(m.text))
    rp.evaluate("location.hash = '#/t/workshop'")
    rws = rp.locator('details.card[data-tool="workshop"]')
    rws.locator('button', has_text='Sign & install').wait_for(timeout=15000)

    def ws_install(kind, name, source=None):
        rws.locator('select[aria-label="Tool type"]').select_option(kind)
        rws.locator('input[placeholder="Tool name"]').fill(name)
        if source is not None:
            rws.locator('textarea').fill(source)
        rws.locator('button', has_text='Sign & install').click()
        rp.locator('.modal button', has_text='Install').click()
        row = rws.locator('.card', has_text=name)
        row.wait_for(timeout=10000)
        row.locator('button', has_text=re.compile(r'^Run$')).click()
        rp.locator('.modal button', has_text='Run once').click()

    ws_install('script', 'Adder', 'host.log("adding"); return 20 + 22')
    rout = rws.locator('pre').last
    rpoll(rp, lambda: rout.inner_text().startswith(('Result', 'Error')), 20)
    ws_res = rout.inner_text()
    check('workshop: a sandboxed script returns its value and its logs', ws_res.startswith('Result: 42') and 'adding' in ws_res, ws_res[:160])
    ws_install('html', 'Pinger')
    rapp = rp.frame_locator('iframe.ws-app-frame').locator('button', has_text='ping room')
    try:
        rapp.wait_for(timeout=10000)
        app_ok = rapp.is_visible()
    except Exception:
        app_ok = False
    check('workshop: an HTML app renders its own UI in the frame', app_ok)
    check('workshop: running both tiers logs no CSP violation',
          not [m for m in rlogs if 'content security policy' in m.lower()], ' | '.join(rlogs)[:200])
    # Served from the app's origin, a guest must still be opaque when opened top-level,
    # and must not expose the capability API there.
    rtop = rc.new_page()
    rtop.goto(f'{BASE}/sandbox/app.html')
    check('workshop: a guest opened top-level has an opaque origin and no host API',
          rtop.evaluate('self.origin') == 'null' and rtop.evaluate('typeof window.host') == 'undefined',
          f"origin={rtop.evaluate('self.origin')!r}")
    rc.close()

    # A failed traineddata download fails the OCR run and the next run retries. tesseract.js
    # swallows that failure, so the shared worker promise used to stay pending and every
    # later recognition in the tab hung on "Loading the OCR engine". A fresh context has no
    # cached traineddata, so blocking the CDN fails the first load for real.
    rc, rp = rf_open()
    rc.route('https://tessdata.projectnaptha.com/**', lambda r: r.abort())
    rpng = base64.b64decode(rp.evaluate('''() => {
      const c = document.createElement('canvas'); c.width = 520; c.height = 140
      const g = c.getContext('2d')
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = '#000'; g.font = 'bold 76px Georgia, serif'; g.textBaseline = 'middle'
      g.fillText('Hello urletc', 18, 74)
      return c.toDataURL('image/png').split(',')[1]
    }'''))
    rp.evaluate("location.hash = '#/t/ocr'")
    rocr = rp.locator('details.card[data-tool="ocr"]')
    rocr.locator('input[type=file]').wait_for(timeout=10000)
    rstatus = rocr.locator('div.muted').first
    rocr.locator('input[type=file]').set_input_files(files=[{'name': 'a.png', 'mimeType': 'image/png', 'buffer': rpng}])
    check('ocr: a blocked language download ends the run with an error',
          bool(rpoll(rp, lambda: rstatus.inner_text().startswith('OCR failed'), 20)), rstatus.inner_text()[:120])
    rc.unroute('https://tessdata.projectnaptha.com/**')
    rocr.locator('input[type=file]').set_input_files(files=[{'name': 'b.png', 'mimeType': 'image/png', 'buffer': rpng}])
    rpoll(rp, lambda: rstatus.inner_text() == 'Done.' or rstatus.inner_text().startswith('OCR failed'), 60)
    check('ocr: the next run after a failed load retries and reads the text',
          'hello' in rocr.locator('pre').inner_text().lower(), f'{rstatus.inner_text()[:80]!r} {rocr.locator("pre").inner_text()[:80]!r}')
    rc.close()

    # A getUserMedia that resolves after a newer Start, a Stop or the card closing is
    # stopped, so the camera light goes off. The init script holds each stream back for
    # half a second, standing in for a permission prompt, and keeps every stream it hands
    # out so the test can count live tracks the page itself can no longer reach.
    SLOW_GUM = """
      window.__gum = []
      const md = navigator.mediaDevices
      const orig = md.getUserMedia.bind(md)
      md.getUserMedia = async (c) => {
        const s = await orig(c)
        window.__gum.push(s)
        await new Promise((r) => setTimeout(r, 500))
        return s
      }
    """
    GUM_LIVE = "() => window.__gum.flatMap((s) => s.getTracks()).filter((t) => t.readyState === 'live').length"
    rc, rp = rf_open(['microphone', 'camera'])
    rc.add_init_script(SLOW_GUM)
    rp.reload()
    rp.wait_for_selector('.composer', timeout=20000)
    rp.evaluate("location.hash = '#/t/device-check'")
    rdc = rp.locator('details.card[data-tool="device-check"]')
    rstart = rdc.locator('button', has_text='Start test')
    rstart.wait_for(timeout=10000)
    rstart.click()
    rstart.click()
    rpoll(rp, lambda: 'Live.' in rdc.inner_text() and rp.evaluate('window.__gum.length') >= 2, 10)
    rpoll(rp, lambda: rp.evaluate(GUM_LIVE) <= 2, 3)
    check('device check: two quick Starts leave one stream live', rp.evaluate(GUM_LIVE) == 2,
          f"{rp.evaluate('window.__gum.length')} streams, {rp.evaluate(GUM_LIVE)} live tracks")
    rdc.locator('button', has_text='Stop').click()
    check('device check: Stop after two quick Starts ends every track',
          bool(rpoll(rp, lambda: rp.evaluate(GUM_LIVE) == 0, 3)), f'{rp.evaluate(GUM_LIVE)} live tracks')
    rdc.locator('button', has_text='Start test').click()
    rwrap = rp.locator('.feed-item', has=rdc)
    rwrap.hover()
    rwrap.locator('button.del').click()
    rwrap.locator('button.del').click()
    rpoll(rp, lambda: rp.evaluate('window.__gum.length') >= 3, 5)
    check('device check: closing the card during the prompt stops the late stream',
          bool(rpoll(rp, lambda: rp.evaluate(GUM_LIVE) == 0, 3)), f'{rp.evaluate(GUM_LIVE)} live tracks')
    # Speech to text records from the mic the same way: a second click while the prompt
    # is up must not start a second recorder that nothing can stop.
    rp.evaluate("location.hash = '#/t/stt'")
    rstt = rp.locator('details.card[data-tool="stt"]')
    rrec = rstt.locator('button', has_text='Record')
    rrec.wait_for(timeout=10000)
    rn0 = rp.evaluate('window.__gum.length')
    rrec.click()
    rrec.click()
    rstop = rstt.locator('button', has_text='Stop & transcribe')
    rstop.wait_for(timeout=5000)
    check('stt: a double click on Record opens the mic once', rp.evaluate('window.__gum.length') - rn0 == 1,
          f"{rp.evaluate('window.__gum.length') - rn0} getUserMedia calls")
    rstop.click()
    check('stt: stopping the recording ends the mic track',
          bool(rpoll(rp, lambda: rp.evaluate(GUM_LIVE) == 0, 3)), f'{rp.evaluate(GUM_LIVE)} live tracks')
    rc.close()

    # Both Pong players see the match end. Only the host scores, and the state carrying
    # the winning point used to be gated on `playing`, which that point had just cleared,
    # so the guest kept the previous score and never saw a result. Both paddles park at
    # the top edge, where a serve from the centre can never reach them, so every rally is
    # a point and the match finishes in seconds. Invites go by device name, because the
    # lobby also lists nearby-tier peers from other contexts on this machine.
    rpcode = 'x' + os.urandom(3).hex()
    rpong = []
    for _ in range(2):
        _c = browser.new_context()
        _p = _c.new_page()
        _p.goto(f'{BASE}/#/join/{rpcode}')
        _p.wait_for_selector('.composer', timeout=20000)
        _p.evaluate("location.hash = '#/t/pong'")
        rpong.append((_c, _p, _p.locator('input[aria-label="This device name"]').first.input_value(),
                      _p.locator('details.card[data-tool="pong"]')))
    (_ca, _pa, _na, _ka), (_cb, _pb, _nb, _kb) = rpong
    _row = _ka.locator('.pong-lobby .row', has_text=_nb)
    if rpoll(_pa, lambda: _row.count() == 1, 90):
        _row.locator('button', has_text='Invite').click()
        _inv = _kb.locator('.pong-lobby .row', has_text=f'{_na} invited you')
        rpoll(_pb, lambda: _inv.count() == 1, 20)
        _inv.locator('button', has_text='Accept').click()
        for _k in (_ka, _kb):
            _k.locator('canvas.pong').wait_for(state='visible', timeout=10000)
            _k.locator('canvas.pong').hover(position={'x': 10, 'y': 2})

        def _ended(k):
            t = k.locator('.pong-score').inner_text()
            return 'you win' in t or 'you lose' in t
        rpoll(_pa, lambda: _ended(_ka) and _ended(_kb), 45)
        _sa, _sb = _ka.locator('.pong-score').inner_text(), _kb.locator('.pong-score').inner_text()
        check('pong: both players see the result when the match ends', _ended(_ka) and _ended(_kb), f'{_sa!r} | {_sb!r}')

        def _score(t):
            m = re.match(r'You (\d+), .* (\d+), you', t)
            return (int(m.group(1)), int(m.group(2))) if m else None
        check('pong: the two players agree on a final score of 7',
              _score(_sa) is not None and _score(_sb) == _score(_sa)[::-1] and max(_score(_sa)) == 7, f'{_sa!r} | {_sb!r}')
    else:
        check('pong: both players see the result when the match ends', False, f'{_nb} never reached the lobby of {_na}')
    _ca.close()
    _cb.close()

    # URL Check: one phishing page on a shared host or one short link in a feed does not
    # flag every other link there. The registrable domain of any *.vercel.app host is
    # vercel.app, so a single listed page used to mark every Vercel site, this app's own
    # included, as a related listing. The feed is stubbed so the listed entries are known.
    rc, rp = rf_open()
    rc.route('https://raw.githubusercontent.com/openphish/public_feed/main/feed.txt',
             lambda r: r.fulfill(status=200, body='https://phish-page.vercel.app/login\nhttps://tinyurl.com/abc123\nhttps://login.evil-example.com/x\n',
                                 headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain'}))
    rp.evaluate("location.hash = '#/t/url-check'")
    ruc = rp.locator('details.card[data-tool="url-check"] .card-body')
    ruc.locator('input.full').wait_for(timeout=10000)

    def uc_feed(url):
        ruc.locator('input.full').fill(url)
        ruc.locator('button', has_text='Check').first.click()
        rpoll(rp, lambda: ruc.locator('.url-check-feedresult').count() == 1, 15)
        return ruc.locator('.url-check-feedresult').inner_text() if ruc.locator('.url-check-feedresult').count() else '(no feed result)'
    for _url, _want, _label in [
        ('https://someone-else.vercel.app/', 'Not on OpenPhish', 'another site on a listed shared host is not a listing'),
        ('https://phish-page.vercel.app/other', 'this hostname is listed', 'the listed host on a shared platform still matches'),
        ('https://tinyurl.com/zzz999', 'Not on OpenPhish', 'another short link on a listed shortener is not a listing'),
        ('https://tinyurl.com/abc123', 'this exact URL is listed', 'the listed short link itself still matches'),
        ('https://sub.evil-example.com/', 'the registrable domain is listed', 'a sibling of a listed ordinary domain still matches'),
    ]:
        _got = uc_feed(_url)
        check(f'url-check feeds: {_label}', _want in _got, f'{_url}: {_got[:120]!r}')
    rc.close()

    # Reformatting JSON keeps every number as written. A round trip through JSON.parse
    # turned 1234567890123456789 into 1234567890123456800, output that still looks valid
    # and gets copied. Driven through the formatter, the Clipboard card's JSON view and
    # the Workshop's default JSON Sorter automation, which parses, sorts keys and prints.
    RJSON = '{"n": 42, "id": 1234567890123456789, "b": 1.50}'
    rc, rp = rf_open(['clipboard-read', 'clipboard-write'])
    rp.evaluate("location.hash = '#/t/json-format'")
    rjf = rp.locator('details.card[data-tool="json-format"]')
    rjf.locator('textarea').fill(RJSON)
    rjf.locator('button', has_text='Format').click()
    _fmt = rjf.locator('pre').inner_text()
    check('json-format: Format keeps an integer above 2^53 and a decimal as written',
          '"id": 1234567890123456789' in _fmt and '"b": 1.50' in _fmt, repr(_fmt))
    rjf.locator('button', has_text='Minify').click()
    _min = rjf.locator('pre').inner_text()
    check('json-format: Minify keeps them too', _min == '{"n":42,"id":1234567890123456789,"b":1.50}', repr(_min))
    rp.evaluate("location.hash = '#/t/clipboard'")
    rcb = rp.locator('details.card[data-tool="clipboard"]').last
    rcb.locator('button', has_text='Scan clipboard').wait_for(timeout=10000)
    rp.evaluate(f'navigator.clipboard.writeText({RJSON!r})')
    rp.evaluate('document.activeElement.blur()')
    rp.keyboard.press('Control+V')
    rpoll(rp, lambda: '1234567890123456' in rcb.inner_text(), 5)
    check('clipboard card: the JSON view keeps an integer above 2^53',
          '"id": 1234567890123456789' in rcb.inner_text(), rcb.inner_text()[-160:])
    rp.evaluate("location.hash = '#/t/workshop'")
    rws = rp.locator('details.card[data-tool="workshop"]')
    rws.locator('button', has_text='Sign & install').wait_for(timeout=15000)
    rws.locator('button', has_text='Sign & install').click()
    rp.locator('.modal button', has_text='Install').click()
    _row = rws.locator('.card', has_text='JSON Sorter')
    _row.wait_for(timeout=10000)
    rp.evaluate(f'navigator.clipboard.writeText({RJSON!r})')
    _row.locator('button', has_text=re.compile(r'^Run$')).click()
    rp.locator('.modal button', has_text='Run once').click()
    _auto = rws.locator('pre').last
    rpoll(rp, lambda: _auto.inner_text().startswith('{'), 5)
    check('workshop automation: sorting keys keeps an integer above 2^53',
          _auto.inner_text() == '{\n  "b": 1.50,\n  "id": 1234567890123456789,\n  "n": 42\n}', repr(_auto.inner_text()))
    rc.close()

    # HTML to Text keeps block boundaries in minified markup. textContent puts nothing
    # between elements, so paragraphs, list items, cells and <br> ran together, and a
    # verification mail laid out as <td>Your code</td><td>483920</td> read "Your code483920".
    # Pretty-printed markup, which already carries its own line breaks, must not gain blank
    # lines from the same pass.
    rc, rp = rf_open()
    rp.evaluate("location.hash = '#/t/html-strip'")
    rhs = rp.locator('details.card[data-tool="html-strip"]')
    rhs.locator('textarea').wait_for(timeout=10000)
    for _src, _want, _label in [
        ('<p>Hello</p><p>World</p><ul><li>One</li><li>Two</li></ul>Line 1<br>Line 2',
         'Hello\nWorld\nOne\nTwo\nLine 1\nLine 2', 'paragraphs, list items and <br> each start a line'),
        ('<table><tr><td>Your code</td><td>483920</td></tr><tr><td>Expires</td><td>10 min</td></tr></table>',
         'Your code\t483920\nExpires\t10 min', 'table cells are tab-separated and rows are lines'),
        ('Intro<div>Block</div>tail <b>bold</b> end', 'Intro\nBlock\ntail bold end', 'inline text around a block breaks at the block only'),
        ('<div>\n  <h1>Title</h1>\n  <p>Para one</p>\n\n  <p>Para two</p>\n</div>',
         'Title\n  Para one\n\n  Para two', 'pretty-printed markup keeps its own line breaks'),
    ]:
        rhs.locator('textarea').fill(_src)
        rhs.locator('button', has_text='Strip to text').click()
        _got = rhs.locator('pre').inner_text()
        check(f'html-strip: {_label}', _got == _want, repr(_got))
    rc.close()

    # URL Check reads Microsoft's own Outlook and OneDrive addresses as first party. The
    # brand sits in a subdomain of another domain the same company owns, and each used to
    # draw a high "brand in a subdomain" finding. The same brand in front of a stranger's
    # domain must still be flagged. The feed is stubbed so no network answer is involved.
    rc, rp = rf_open()
    rc.route('https://raw.githubusercontent.com/openphish/public_feed/main/feed.txt',
             lambda r: r.fulfill(status=200, body='https://login.evil-example.com/x\n',
                                 headers={'Access-Control-Allow-Origin': '*', 'Content-Type': 'text/plain'}))
    rp.evaluate("location.hash = '#/t/url-check'")
    ruc = rp.locator('details.card[data-tool="url-check"] .card-body')
    ruc.locator('input.full').wait_for(timeout=10000)
    for _url, _flag in [
        ('https://outlook.office.com/mail/', False),
        ('https://onedrive.live.com/', False),
        ('https://outlook.live.com/owa/', False),
        ('https://outlook.office.com.evil-login.tk/', True),
        ('https://onedrive.live-files.com/', True),
    ]:
        ruc.locator('input.full').fill(_url)
        ruc.locator('button', has_text='Check').first.click()
        rpoll(rp, lambda: ruc.locator('.url-check-structural').count() == 1, 5)
        _st = ruc.locator('.url-check-structural').inner_text()
        check(f"url-check: {_url} {'is' if _flag else 'is not'} flagged as a brand in a subdomain",
              ('sits in a subdomain' in _st) == _flag, _st[:140])
    rc.close()

    # Title case capitalises a word that opens with an accented letter on that letter, where
    # an ASCII-only \w would give "óTimo" and "ÚLtima".
    rc, rp = rf_open()
    rp.evaluate("location.hash = '#/t/text-utils'")
    rtu = rp.locator('details.card[data-tool="text-utils"]')
    rtu.locator('textarea').wait_for(timeout=10000)
    rtu.locator('textarea').fill('ótimo ângela ÚLTIMA NOTÍCIA (test) 3rd')
    rtu.locator('button', has_text=re.compile(r'^Title$')).click()
    _tc = rtu.locator('pre').inner_text()
    check('text-utils: Title capitalises accented initials, bracketed words and leaves 3rd alone',
          _tc == 'Ótimo Ângela Última Notícia (Test) 3rd', repr(_tc))
    rc.close()

    # An open Studio card follows the code room: stopping it swaps the stage link for the
    # hint, and creating a new one brings the link back with the new code in it.
    rc, rp = rf_open(['clipboard-read', 'clipboard-write'])
    rp.evaluate("location.hash = '#/t/studio'")
    rst = rp.locator('details.card[data-tool="studio"]')
    rst.locator('button', has_text='Publish camera').wait_for(timeout=10000)
    rsl = rst.locator('button', has_text='Copy stage link')
    check('studio: a card opened inside a code room offers the stage link', bool(rpoll(rp, lambda: rsl.count() == 1, 5)))
    rp.locator('.topbar button', has_text='Connect').click()
    rp.locator('.modal button', has_text='Stop code room').click()
    rp.locator('.modal button', has_text='Create a code').wait_for(timeout=5000)
    check('studio: stopping the code room swaps the link for the join hint',
          bool(rpoll(rp, lambda: rsl.count() == 0 and 'start or join a code room' in rst.inner_text(), 5)), rst.inner_text()[-160:])
    rp.locator('.modal button', has_text='Create a code').click()
    rp.locator('.modal button', has_text='Stop code room').wait_for(timeout=10000)
    rp.keyboard.press('Escape')
    _code = (rpoll(rp, lambda: rp.locator('button.code-chip').inner_text().strip().lower(), 5) or '')
    check('studio: a new code room brings the stage link back', bool(_code) and bool(rpoll(rp, lambda: rsl.count() == 1, 5)))
    if rsl.count():
        rsl.click()
        _clip = rpoll(rp, lambda: rp.evaluate('navigator.clipboard.readText()'), 5) or ''
        check('studio: the refreshed stage link points at the new code', ('#/stage/' + _code) in _clip.lower(), f'{_code!r} {_clip!r}')
    rc.close()

    # A signed tool whose type names one tier and whose body carries another is refused on
    # import, while the same body under its own type installs and lists as that type. The
    # manifests are signed in the page with a fresh key, the way another author would.
    RSIGN = """async ([type, kind, name]) => {
      const enc = new TextEncoder()
      const canon = (v) => v === null || typeof v !== 'object' ? JSON.stringify(v)
        : Array.isArray(v) ? '[' + v.map(canon).join(',') + ']'
        : '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}'
      const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')
      const hash = async (v) => 'sha256:' + hex(await crypto.subtle.digest('SHA-256', enc.encode(canon(v))))
      const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
      const pub = hex(await crypto.subtle.exportKey('raw', kp.publicKey))
      const body = { kind, source: '<p>app body</p>' }
      const permissions = ['storage']
      const contentHash = await hash(body)
      const id = await hash({ name, version: '1', type, permissions, contentHash })
      const meta = { id, name, version: '1', type, author: { pubkey: 'ed25519:' + pub, displayName: 'peer' }, createdAt: 1, permissions, contentHash }
      const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', kp.privateKey, enc.encode(canon(meta))))
      return JSON.stringify({ ...meta, body, sig: 'ed25519:' + btoa(String.fromCharCode(...sig)) })
    }"""
    rc, rp = rf_open()
    rp.evaluate("location.hash = '#/t/workshop'")
    rws = rp.locator('details.card[data-tool="workshop"]')
    rws.locator('button', has_text='Sign & install').wait_for(timeout=15000)
    _bad = rp.evaluate(RSIGN, ['automation', 'html', 'Disguised'])
    rws.locator('input[type=file]').set_input_files(files=[{'name': 'd.wtool.json', 'mimeType': 'application/json', 'buffer': _bad.encode()}])
    check('workshop import: an automation carrying an html body is rejected',
          bool(rpoll(rp, lambda: rp.locator('.toast', has_text='type / body mismatch').count() > 0, 5)),
          ' | '.join(rp.locator('.toast').all_inner_texts()))
    check('workshop import: the mislabelled tool gets no consent dialog and no list entry',
          rp.locator('.modal').count() == 0 and rws.locator('.card', has_text='Disguised').count() == 0)
    _good = rp.evaluate(RSIGN, ['html', 'html', 'Honest'])
    rws.locator('input[type=file]').set_input_files(files=[{'name': 'h.wtool.json', 'mimeType': 'application/json', 'buffer': _good.encode()}])
    rp.locator('.modal button', has_text='Install').click(timeout=5000)
    _hrow = rws.locator('.card', has_text='Honest')
    check('workshop import: the same body under its own type installs and lists as html',
          bool(rpoll(rp, lambda: _hrow.count() == 1 and 'v1, html' in _hrow.inner_text(), 5)))
    rc.close()

    # Session tool and game handlers fan out per card. Workshop shares and relays on the
    # personal room, so two contexts open one pairing link and meet only there. On B,
    # closing one of two Workshop cards leaves the other listing a tool A shares, and a
    # Workshop app keeps hearing A's copy of the app while a Pong card is open and after
    # it closes.
    _hpair = base64.b64encode(os.urandom(32)).decode().replace('+', '%2B').replace('/', '%2F').replace('=', '%3D')

    def rf_peer():
        c = browser.new_context()
        pg = c.new_page()
        pg.goto(f'{BASE}/#/pair?s={_hpair}')
        pg.wait_for_selector('.composer', timeout=20000)
        return c, pg

    def ws_card_install(pg, card, kind, name):
        card.locator('select[aria-label="Tool type"]').select_option(kind)
        card.locator('input[placeholder="Tool name"]').fill(name)
        card.locator('button', has_text='Sign & install').click()
        pg.locator('.modal button', has_text='Install').click()
        row = card.locator('.card', has_text=name)
        row.wait_for(timeout=10000)
        return row

    def rf_until(pg, act, cond, seconds, every=3):
        """Repeat a send until its effect shows: a send before the pair's handshake is lost."""
        for _ in range(int(seconds / every)):
            act()
            if rpoll(pg, cond, every):
                return True
        return False

    _no_device = "document.querySelector('.sidebar').textContent.includes('None yet. Open Connect to pair a device.')"
    ha, hpa = rf_peer()
    hb, hpb = rf_peer()
    _hpaired = rpoll(hpa, lambda: not hpa.evaluate(_no_device) and not hpb.evaluate(_no_device), 150)
    check('handlers: two contexts on one pairing link list each other under My devices', bool(_hpaired))
    if _hpaired:
        hpb.evaluate("location.hash = '#/t/workshop'")
        hpb.locator('details.card[data-tool="workshop"] button', has_text='Sign & install').first.wait_for(timeout=15000)
        hpb.evaluate("location.hash = ''")
        hpb.evaluate("location.hash = '#/t/workshop'")
        _bws = hpb.locator('details.card[data-tool="workshop"]')
        rpoll(hpb, lambda: _bws.nth(1).locator('button', has_text='Sign & install').count() == 1, 15)
        _bwrap = hpb.locator('.feed-item', has=hpb.locator('details.card[data-tool="workshop"]')).first
        _bwrap.hover()
        _bwrap.locator('button.del').click()
        _bwrap.locator('button.del').click()
        check('handlers: one of two Workshop cards on B is closed', bool(rpoll(hpb, lambda: _bws.count() == 1, 5)))
        hpa.evaluate("location.hash = '#/t/workshop'")
        _aws = hpa.locator('details.card[data-tool="workshop"]')
        _aws.locator('button', has_text='Sign & install').wait_for(timeout=15000)
        _ashare = ws_card_install(hpa, _aws, 'automation', 'Fanout Sorter').locator('button', has_text='Share to room')
        check('handlers: the Workshop card left open on B lists the tool A shares',
              rf_until(hpb, _ashare.click, lambda: 'Shared by peers' in _bws.inner_text() and 'Fanout Sorter' in _bws.inner_text(), 60),
              _bws.inner_text()[:200])
        for _pg, _card in ((hpa, _aws), (hpb, _bws)):
            ws_card_install(_pg, _card, 'html', 'Fanout Pinger').locator('button', has_text=re.compile(r'^Run$')).click()
            _pg.locator('.modal button', has_text='Run once').click()
        _aping = hpa.frame_locator('iframe.ws-app-frame').locator('button', has_text='ping room')
        _aping.wait_for(timeout=10000)
        hpb.frame_locator('iframe.ws-app-frame').locator('button', has_text='ping room').wait_for(timeout=10000)
        hpb.evaluate("location.hash = '#/t/pong'")
        _bpong = hpb.locator('details.card[data-tool="pong"]')
        _bpong.locator('.pong-lobby').wait_for(state='attached', timeout=10000)
        _bout = _bws.locator('pre').last
        check('handlers: a Workshop app on B hears the room while a Pong card is open',
              rf_until(hpb, _aping.click, lambda: _bout.inner_text().count('from ') >= 1, 15), _bout.inner_text()[-160:])
        _bpwrap = hpb.locator('.feed-item', has=_bpong)
        _bpwrap.hover()
        _bpwrap.locator('button.del').click()
        _bpwrap.locator('button.del').click()
        rpoll(hpb, lambda: _bpong.count() == 0, 5)
        _heard = _bout.inner_text().count('from ')
        check('handlers: the app on B still hears the room after the Pong card closes',
              rf_until(hpb, _aping.click, lambda: _bout.inner_text().count('from ') > _heard, 15), _bout.inner_text()[-160:])
    ha.close()
    hb.close()

    # A Workshop install the tool quota refuses says so, and the refused tool does not come
    # back with the next write. Two apps near the 512 KiB body cap together pass the 1 MiB
    # namespace quota. Removing the first one afterwards leaves an empty list across a reload.
    rc, rp = rf_open()
    rp.evaluate("location.hash = '#/t/workshop'")
    rws = rp.locator('details.card[data-tool="workshop"]')
    rws.locator('button', has_text='Sign & install').wait_for(timeout=15000)
    rws.locator('select[aria-label="Tool type"]').select_option('html')
    for _name in ('Big One', 'Big Two'):
        rws.locator('input[placeholder="Tool name"]').fill(_name)
        rws.locator('textarea').fill('<p>' + _name[-3:] * 174758 + '</p>')
        rws.locator('button', has_text='Sign & install').click()
        rp.locator('.modal button', has_text='Install').click()
        rpoll(rp, lambda: rp.locator('.toast', has_text=re.compile('Installed|failed')).count() > 0, 10)
        if _name == 'Big One':
            check('workshop quota: the first large app installs', rws.locator('.card', has_text='Big One').count() == 1)
            rpoll(rp, lambda: rp.locator('.toast').count() == 0, 5)
    check('workshop quota: an install past the quota shows why it failed',
          rp.locator('.toast', has_text='Install failed: tool storage quota exceeded').count() == 1,
          ' | '.join(rp.locator('.toast').all_inner_texts()))
    check('workshop quota: the refused app is not listed', rws.locator('.card', has_text='Big Two').count() == 0)
    _big = rws.locator('.card', has_text='Big One')
    _big.locator('button', has_text='Remove').click()
    rpoll(rp, lambda: _big.count() == 0, 5)
    rp.reload()
    rp.wait_for_selector('.composer', timeout=20000)
    rws = rp.locator('details.card[data-tool="workshop"]')
    rws.locator('button', has_text='Sign & install').wait_for(timeout=15000)
    check('workshop quota: after a reload the refused app stays gone and the removed one too',
          bool(rpoll(rp, lambda: 'Nothing installed yet.' in rws.inner_text(), 5)), rws.inner_text()[:300])
    rc.close()

    # --- 13n. Studio (VDO.ninja-style A/V): publish controls, labeled source, layouts, stage link ---
    page.evaluate("location.hash = '#/t/studio'")
    studio = page.locator('details.card').last
    try:
        studio.locator('button', has_text='Publish camera').wait_for(timeout=10000)
    except Exception:
        pass
    check('studio renders publish controls', studio.locator('button', has_text='Publish camera').count() == 1)
    check('studio has camera + mic + res selects', studio.locator('select').count() == 3)
    check('studio has grid/focus/solo layout switch',
          studio.locator('button', has_text=re.compile(r'^(Grid|Focus|Solo)$')).count() == 3)
    # publish the fake camera, so a labeled stage tile and a source-list entry appear
    studio.locator('button', has_text='Publish camera').click()
    try:
        page.wait_for_selector('.tiles.stage .stage-tile', timeout=10000)
        check('publishing camera creates a stage tile', page.locator('.stage-tile').count() >= 1)
        check('stage tile has a nameplate', page.locator('.stage-tile .tile-name').count() >= 1)
        check('source appears in the studio list', studio.locator('.src-name').count() >= 1)
        # switch layout, so the stage container reflects it and a tile is spotlighted.
        # The button reads Focus, the layout value and its stage class stay 'spotlight'.
        studio.locator('button', has_text=re.compile(r'^Focus$')).click()
        page.wait_for_timeout(200)
        check('layout switch applies to the stage', page.locator('.tiles.stage.layout-spotlight').count() == 1)
        check('a tile is spotlighted', page.locator('.stage-tile.spot').count() == 1)
    except Exception as e:
        check('publishing camera creates a stage tile', False, str(e)[:160])
    # stage link (OBS): a code room is auto-active, so the link is offered
    slink = studio.locator('button', has_text='Copy stage link')
    check('studio offers an OBS stage link', slink.count() == 1)
    code_now = (page.locator('button.code-chip').inner_text().strip().lower() if page.locator('button.code-chip').count() else '')
    if slink.count() and code_now:
        slink.click()
        clip = clip_after(page, lambda t: ('#/stage/' + code_now) in t.lower())
        check('stage link is a #/stage/<code> URL', ('#/stage/' + code_now) in clip.lower(), clip)
    studio.locator('button', has_text='Stop all').click()
    page.wait_for_timeout(300)

    # --- 13o. chromeless stage route (#/stage/<code>) renders only the stage (OBS source) ---
    if code_now:
        stage_pg = ctx.new_page()
        stage_pg.goto(f'{BASE}/#/stage/{code_now}')
        stage_pg.wait_for_selector('.app-shell', timeout=20000)
        stage_pg.wait_for_timeout(800)
        check('stage route enters chromeless mode', stage_pg.evaluate("document.documentElement.classList.contains('stage-view')"))
        check('stage route hides the topbar', not stage_pg.locator('.topbar').is_visible())
        check('stage route hides the composer', not stage_pg.locator('.composer-wrap').is_visible())
        stage_pg.close()

    # --- 13p. disposable email: an address is really issued, not just mounted ---
    # The tool depends on a live third party handing back a working address, so drive it:
    # wait for a real address on a real domain, copy it, and check it survives into a fresh
    # page, where the only place it can come from is ctx.storage (per-card state is a
    # WeakMap, so a new page has none). A machine without egress cannot reach the provider,
    # so that branch asserts the status line says so instead of hanging or sitting blank.
    tm_before = len(logs)
    page.evaluate("location.hash = '#/t/tempmail'")
    tm = page.locator('details.card').last
    try:
        tm.locator('.tm-status').first.wait_for(timeout=10000)
    except Exception:
        pass
    check('tempmail card renders', 'Disposable Email' in tm.locator('summary').inner_text(),
          tm.locator('summary').inner_text()[:80])
    check('tempmail states the inbox is public and third-party run',
          'never for anything private' in tm.inner_text().lower(), tm.inner_text()[:140])
    # The address lands before the first inbox fetch returns, so waiting on the address
    # alone samples a half-finished claim. Wait for a terminal status instead: polling
    # started, or the provider named as unreachable.
    tm_addr, tm_status = '', ''
    for _ in range(40):
        tm_addr = tm.locator('input.tm-addr').first.input_value().strip()
        tm_status = tm.locator('.tm-status').first.inner_text().strip().lower()
        if 'checking every' in tm_status or 'did not answer' in tm_status or 'rate limiting' in tm_status:
            break
        page.wait_for_timeout(500)
    online = bool(re.match(r'^[a-z][a-z0-9]{5,}@[a-z0-9.-]+\.[a-z]{2,}$', tm_addr)) and 'checking every' in tm_status
    graceful = 'did not answer' in tm_status or 'rate limiting' in tm_status
    check('tempmail issues an address and starts polling, or reports the provider is unreachable',
          online or graceful, f'addr={tm_addr!r} status={tm_status[:110]!r}')
    if online:
        check('tempmail renders an inbox list (empty is a real state)',
              tm.locator('.tm-list').inner_text().strip() != '')
        tm.locator('button', has_text='Copy').first.click()
        clip_tm = clip_after(page, lambda t: t.strip() == tm_addr).strip()
        check('tempmail copies the issued address', clip_tm == tm_addr, f'{clip_tm!r} vs {tm_addr!r}')
        # Reload equivalence. A second page in the same browser context shares IndexedDB
        # but gets a fresh module instance, so an address that comes back there came out
        # of ctx.storage rather than a module-level variable.
        pg4 = ctx.new_page()
        pg4.goto(f'{BASE}/#/t/tempmail')
        pg4.wait_for_selector('input.tm-addr', timeout=20000)
        again = ''
        for _ in range(20):
            again = pg4.locator('input.tm-addr').first.input_value().strip()
            if again:
                break
            pg4.wait_for_timeout(500)
        check('tempmail keeps the same inbox across a reload (ctx.storage)',
              again == tm_addr, f'{again!r} vs {tm_addr!r}')
        pg4.close()
        # Throwing the inbox away must actually claim a different one, not relabel the old.
        tm.locator('button', has_text='New address').click()
        rotated = ''
        for _ in range(40):
            rotated = tm.locator('input.tm-addr').first.input_value().strip()
            if rotated and rotated != tm_addr:
                break
            page.wait_for_timeout(500)
        check('tempmail can throw the inbox away and claim another',
              bool(rotated) and rotated != tm_addr, f'{rotated!r} vs {tm_addr!r}')
    else:
        check('tempmail names the failure instead of stalling on a half-claim',
              graceful and 'claiming' not in tm_status, tm_status[:110])
    # A live inbox is empty, so the render path for an incoming message never runs against
    # the real provider. Drive it with API-shaped payloads on a page whose fetch is stubbed
    # for api.mail.gw only: the transport is canned, the message is not. The body carries
    # markup plus a script tag so the strip is exercised. Works with no egress at all.
    STUB = """
      const REAL = window.fetch.bind(window)
      const AT = String.fromCharCode(64)
      const M = {id: 'm1', from: {address: 'sender' + AT + 'stub.example', name: 'Sender'},
                 subject: 'Confirm your signup', seen: false, createdAt: new Date().toISOString()}
      const BODY = Object.assign({}, M, {text: '',
        html: ['<p>Your code is <b>424242</b></p>' + '<scr' + 'ipt>alert(1)</scr' + 'ipt>']})
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : (input && input.url) || ''
        if (url.indexOf('https://api.mail.gw') !== 0) return REAL(input, init)
        const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o),
          {status: s || 200, headers: {'Content-Type': 'application/json'}}))
        if (url.endsWith('/domains')) return json({'hydra:member': [{domain: 'stub.example', isActive: true}]})
        if (url.endsWith('/accounts')) return json({address: 'stub' + AT + 'stub.example'}, 201)
        if (url.endsWith('/token')) return json({token: 'stub-token'})
        if (/\\/messages\\/[^/]+$/.test(url)) return json(BODY)
        if (url.endsWith('/messages')) return json({'hydra:member': [M]})
        return json({}, 404)
      }
    """
    pg5 = ctx.new_page()
    pg5_errs = []
    pg5.on('pageerror', lambda e: pg5_errs.append(str(e)))
    pg5.add_init_script(STUB)
    pg5.goto(f'{BASE}/#/t/tempmail')
    try:
        pg5.wait_for_selector('.tm-msg', timeout=20000)
        row = pg5.locator('.tm-msg').first.inner_text()
        check('tempmail lists a received message with sender and subject',
              'sender' in row and 'stub.example' in row and 'Confirm your signup' in row, row[:120])
        pg5.locator('.tm-msg').first.click()
        pg5.wait_for_timeout(600)
        body = pg5.locator('.tm-body').first.inner_text()
        check('tempmail renders the message body as text', '424242' in body, body[:120])
        check('tempmail strips markup and script content out of the body',
              '<b>' not in body and 'alert(1)' not in body and '<p>' not in body, body[:120])
    except Exception as e:
        check('tempmail lists a received message with sender and subject', False, str(e)[:140])
    check('tempmail raises no page error while rendering a hostile body', not pg5_errs, ' | '.join(pg5_errs)[:160])
    pg5.close()

    # Rendering a message that was already there covers only the render. Mail has to show
    # up on its own, so the stub holds the inbox empty for the first check and opens it on
    # the next: the row can then only come from a second, unprompted fetch. Nothing is
    # clicked. A tool that renders on demand but never polls is indistinguishable from one
    # that is not receiving mail.
    def mailgw_stub(body):
        return """
          const REAL = window.fetch.bind(window)
          const AT = String.fromCharCode(64)
          window.__polls = 0
          window.__accounts = 0
          window.__tokens = 0
          const M = {id: 'm2', from: {address: 'later' + AT + 'stub.example', name: 'Later'},
                     subject: 'Arrived while you waited', seen: false,
                     createdAt: new Date().toISOString(), text: 'body 987654'}
          window.fetch = (input, init) => {
            const url = typeof input === 'string' ? input : (input && input.url) || ''
            if (url.indexOf('https://api.mail.gw') !== 0) return REAL(input, init)
            const json = (o, s) => Promise.resolve(new Response(JSON.stringify(o),
              {status: s || 200, headers: {'Content-Type': 'application/json'}}))
            if (url.endsWith('/domains')) return json({'hydra:member': [{domain: 'stub.example', isActive: true}]})
            if (url.endsWith('/accounts')) { window.__accounts++; %s }
            if (url.endsWith('/token')) { window.__tokens++; return json({token: 'stub-token'}) }
            if (/\\/messages\\/[^/]+$/.test(url)) return json(M)
            if (url.endsWith('/messages')) { window.__polls++; %s }
            return json({}, 404)
          }
        """ % body

    def drive_stub(script, want, budget=45):
        """Open the tool on a stubbed page and wait for `want(page)`. Returns (page, met).

        Its own browser context rather than `ctx`, because the tool restores a saved
        address from IndexedDB: a page sharing storage with the live run above never
        reaches the claim path, so claim assertions would pass for the wrong reason. A
        fresh context is the only way to reach a first-run inbox.
        """
        c = browser.new_context()
        pg = c.new_page()
        pg.add_init_script(script)
        pg.goto(f'{BASE}/#/t/tempmail')
        pg.wait_for_selector('input.tm-addr', timeout=20000)
        for _ in range(budget):
            if want(pg):
                return (pg, c), True
            pg.wait_for_timeout(1000)
        return (pg, c), False

    ARRIVES = mailgw_stub(("return json({address: 'stub' + AT + 'stub.example'}, 201)",
                           "return json({'hydra:member': window.__polls > 1 ? [M] : []})"))
    (pg6, cx6), arrived = drive_stub(ARRIVES, lambda p: p.locator('.tm-msg').count() > 0)
    check('tempmail shows mail that arrives after the first check, with nothing clicked',
          arrived, f'polls={pg6.evaluate("window.__polls")} status={pg6.locator(".tm-status").first.inner_text()[:80]!r}')
    check('tempmail re-reads the one inbox it claimed instead of claiming another per poll',
          pg6.evaluate('window.__accounts') == 1, f'accounts={pg6.evaluate("window.__accounts")}')
    cx6.close()

    # A refused claim is the only state with no address on screen, so it is the one that
    # most needs to retry. A status line promising a next check proves nothing on its own,
    # because no timer need be armed behind it. Two claim attempts is the assertion; one
    # means it wedged until Refresh.
    REFUSED = mailgw_stub(('return json({}, 429)', "return json({'hydra:member': []})"))
    (pg7, cx7), retried = drive_stub(REFUSED, lambda p: p.evaluate('window.__accounts') >= 2, budget=40)
    check('tempmail retries a claim the provider refused instead of wedging with no address',
          retried, f'accounts={pg7.evaluate("window.__accounts")}')
    check('tempmail names the rate limit while it keeps retrying',
          'rate limiting' in pg7.locator('.tm-status').first.inner_text().lower(),
          pg7.locator('.tm-status').first.inner_text()[:110])
    cx7.close()

    # A 401 on /messages means an expired token, not a dead account. Re-claiming on it
    # throws away an inbox that may already hold mail, so the tool has to log in again and
    # keep the address it is showing.
    EXPIRED = mailgw_stub(("return json({address: 'stub' + AT + 'stub.example'}, 201)",
                           "if (window.__polls === 1) return json({}, 401);\n"
                           "              return json({'hydra:member': [M]})"))
    (pg8, cx8), recovered = drive_stub(EXPIRED, lambda p: p.locator('.tm-msg').count() > 0)
    check('tempmail logs in again on an expired token rather than abandoning the inbox',
          recovered and pg8.evaluate('window.__accounts') == 1 and pg8.evaluate('window.__tokens') >= 2,
          f'accounts={pg8.evaluate("window.__accounts")} tokens={pg8.evaluate("window.__tokens")}')
    cx8.close()

    tm_errs = [l for l in logs[tm_before:] if l.startswith('pageerror:')]
    check('tempmail raises no page error on either path', not tm_errs, ' | '.join(tm_errs)[:160])

    # --- 14. slash filter opens launcher ---
    page.locator('.composer textarea').fill('/json')
    page.locator('.composer textarea').press('Enter')
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    names = page.eval_on_selector_all('.menu.tool-grid button.tool-open', 'els => els.map(e => e.textContent)')
    check('slash filter narrows tools', len(names) >= 1 and all('JSON' in n for n in names), str(names))
    page.mouse.click(400, 300)

    # --- 15. tool deep-link (#/t/<id>) opens the tool ---
    page.evaluate("location.hash = '#/t/base64'")
    page.wait_for_timeout(500)
    check('deep-link #/t/base64 opens the tool', page.locator('details.card summary', has_text='Base64').count() >= 1)

    # window.scrollY is always 0 here because .app-shell is overflow:hidden, so asserting
    # on it says nothing: the composer can be squeezed to its padding and pushed under the
    # viewport edge while scrollY stays 0. Two separate bugs hid behind that. .composer-wrap
    # carries overflow:hidden to reserve the scrollbar gutter, and a grid item only gets an
    # automatic min-content floor while overflow is visible, so the row collapsed to 24px
    # against the 122px it needed. Separately .center placed its rows positionally while the
    # stage and captions are display:none when idle, so the feed slid onto the auto row and
    # grew to full content height. Measure the geometry instead.
    # The row-shift half only appears with an idle stage, since .tiles-region and .captions
    # are display:none then and the remaining children slide up a row. Late in this run the
    # stage may still hold tiles, which restores the correct order by accident, so the
    # precondition is forced rather than assumed.
    page.evaluate("() => { const t=document.querySelector('.tiles-region');"
                 " return t ? getComputedStyle(t).display : 'absent' }")
    check('stage is idle for the composer geometry check',
          page.evaluate("() => { const t=document.querySelector('.tiles-region');"
                        " return !t || getComputedStyle(t).display === 'none' }"))
    check('feed is full enough to claim the free space',
          page.evaluate("() => { const f=document.querySelector('.feed');"
                        " return f.scrollHeight > f.clientHeight }"))
    layout = page.evaluate("""() => {
      const cw = document.querySelector('.composer-wrap')
      const ta = document.querySelector('.composer textarea')
      const send = [...document.querySelectorAll('.composer button')].pop()
      const r = cw.getBoundingClientRect()
      return {scrollY: window.scrollY,
              clipped: cw.scrollHeight > Math.ceil(r.height) + 1,
              belowFold: Math.round(r.bottom) > window.innerHeight + 1,
              taH: ta.getBoundingClientRect().height,
              sendVisible: send ? send.getBoundingClientRect().bottom <= window.innerHeight + 1 : false}
    }""")
    check('document never scrolls', layout['scrollY'] == 0)
    check('composer is not clipped by its own overflow', not layout['clipped'], str(layout))
    check('composer sits inside the viewport with a full feed', not layout['belowFold'], str(layout))
    check('composer textarea has real height', layout['taH'] > 10, str(layout))
    check('send button is reachable on screen', layout['sendVisible'], str(layout))
    check('topbar still visible at end', page.locator('.topbar .brand').is_visible())
    page.screenshot(path=f'{SNAP}/e2e-final-dark.png', full_page=False)
    # Snapshot artifact only, no assertion; the theme itself is asserted through the
    # Settings control in section 4. Flipped on the element here so the light snapshot does
    # not depend on opening a tool card this late in the run.
    page.evaluate("document.documentElement.setAttribute('data-theme', 'light')")
    page.screenshot(path=f'{SNAP}/e2e-final-light.png', full_page=False)
    page.evaluate("document.documentElement.setAttribute('data-theme', 'dark')")

    # --- every registered tool must mount without crashing or violating the CSP ---
    # A tool nothing here opens can be entirely dead and leave the run green: a Worker
    # constructor blocked by Trusted Types silently takes out every feature behind it.
    # Opening every registered tool is what keeps a whole tool from going dark unnoticed.
    ids = tool_ids()
    print(f'\n--- mounting all {len(ids)} tools ---')
    mount_failures = []
    for tid in ids:
        before = len(logs)
        cards_before = page.locator('details.card').count()
        try:
            # cards accumulate in the feed, so mounting is "one more card", not "any card"
            page.evaluate(f"location.hash = '#/t/{tid}'")
            page.wait_for_timeout(1200)
            if page.locator('details.card').count() <= cards_before:
                mount_failures.append(f'{tid}: card did not render')
                continue
        except Exception as e:
            mount_failures.append(f'{tid}: {str(e)[:80]}')
            continue
        new = logs[before:]
        fatal_here = [l for l in new
                      if 'trustedscript' in l.lower() or 'trustedhtml' in l.lower()
                      or 'trusted type' in l.lower()
                      or 'content security policy' in l.lower() or 'refused to load' in l.lower()
                      or l.startswith('pageerror:')]
        if fatal_here:
            mount_failures.append(f'{tid}: {fatal_here[0][:110]}')
    check(f'all {len(ids)} tools mount without a CSP violation or crash',
          not mount_failures, ' | '.join(mount_failures[:4]))

    # --- every pure text tool is driven with real input, not just mounted ---
    # Mounting only covers the module import; the loop above passed on html-strip for as
    # long as html-strip was broken. Each tool with an obvious input and output gets a
    # known input, a real trigger, and an assertion that something non-empty and non-error
    # came back.
    # (id, [(selector, nth, value)], trigger button text or None, output selector, reject substrings)
    SMOKE = [
        ('base64', [('textarea', 0, 'urletc')], 'Encode', 'pre', ('error', 'invalid')),
        ('hash', [('textarea', 0, 'abc')], 'Hash text', 'pre', ('failed', 'hex digest')),
        ('json-format', [('textarea', 0, '{"b":1,"a":[2,3]}')], 'Format', 'pre', ('invalid json',)),
        ('text-utils', [('textarea', 0, 'hello world')], 'UPPER', 'pre', ()),
        ('diff', [('textarea', 0, 'one\ntwo'), ('textarea', 1, 'one\nTWO')], 'Diff', 'pre.diff', ('too many lines', 'line diff appears')),
        ('epoch', [('input.mono-input', 0, '1700000000')], None, '.gen-value', ()),
        ('html-strip', [('textarea', 0, '<p>plain <b>result</b></p>')], 'Strip to text', 'pre', ('plain text output',)),
    ]
    print(f'\n--- driving {len(SMOKE)} text tools ---')
    for tid, fills, trigger, out_sel, reject in SMOKE:
        before = len(logs)
        try:
            page.evaluate(f"location.hash = '#/t/{tid}'")
            page.wait_for_timeout(700)
            card = page.locator('details.card').last
            for sel, nth, val in fills:
                card.locator(sel).nth(nth).fill(val)
            if trigger:
                card.locator('button', has_text=trigger).first.click()
            page.wait_for_timeout(350)
            text = card.locator(out_sel).first.inner_text().strip()
        except Exception as e:
            check(f'{tid}: driven input produces output', False, str(e)[:110])
            continue
        low = text.lower()
        bad = [l for l in logs[before:]
               if 'trustedhtml' in l.lower() or 'trusted type' in l.lower()
               or 'trustedscript' in l.lower() or l.startswith('pageerror:')]
        ok = bool(text) and text not in ('-', '(empty)') and not any(r in low for r in reject) and not bad
        check(f'{tid}: driven input produces output',
              ok, (bad[0][:110] if bad else f'output={text[:70]!r}'))

    # ===================== url check + shorten (driven) =====================
    # Self-contained block; nothing above is restructured. Both tools get real input and
    # are asserted on real output rather than on a card having rendered.

    # The link under inspection must never be fetched, and the 3.6 MB bulk feed must never
    # be pulled without being asked for. Both are watched on the wire.
    offsite = []

    def _watch_request(r):
        if r.url.startswith(('http://', 'https://')) and not r.url.startswith(BASE):
            offsite.append(r.url)

    page.on('request', _watch_request)

    UC = tool_id_for('url-safety')

    # A live known-bad URL, taken from OpenPhish at test time. The feed rotates, so a
    # hardcoded sample stops being listed and the assertion then passes for the wrong
    # reason or fails forever. Fetched out of band through Playwright's request context,
    # so choosing the sample is independent of what the page can reach.
    OPENPHISH = 'https://raw.githubusercontent.com/openphish/public_feed/main/feed.txt'
    sample, feed_lines = None, 0
    try:
        fr = page.request.get(OPENPHISH, timeout=30000)
        if fr.ok:
            for ln in fr.text().splitlines():
                ln = ln.strip()
                if ln.startswith(('http://', 'https://')) and ' ' not in ln:
                    feed_lines += 1
                    if sample is None:
                        sample = ln
    except Exception:
        sample = None
    check('url-check: the OpenPhish feed is reachable and non-empty', bool(sample) and feed_lines > 10,
          f'{feed_lines} usable lines')
    sample_host = re.sub(r'^https?://', '', sample or '').split('/')[0].split(':')[0] if sample else ''

    # Every structural trick at once: credentials before the @, a brand in a subdomain, a
    # punycode label that decodes to Latin + Cyrillic, a free-registration TLD, an odd
    # port, plain http, and double percent-encoding. The @ is spelled with chr(64) so the
    # literal is not mistaken for an address.
    NASTY = ('http://admin:hunter2' + chr(64) + 'paypal.com.login-verify.xn--pypal-4ve.tk:8081'
             '/reset%2Fpass%2Fnow%252Fdeep%2Fx%2Fy?to=%2Faccount%2Fx')
    # URL Inspector was merged into URL Check, so #/t/url-info is a retired id. Links to
    # it are already out in shared history and must land on the merged tool instead of
    # dead-ending on a card that never opens.
    uc_cards = page.locator('details.card summary', has_text='URL Check')
    n_uc = uc_cards.count()  # the mount-all pass above already left one, so count the delta
    page.evaluate("location.hash = '#/t/url-info'")
    page.wait_for_timeout(900)
    check('retired #/t/url-info redirects to the merged tool',
          page.evaluate('location.hash') == '#/t/url-check', page.evaluate('location.hash'))
    check('the redirect really opens URL Check, it does not just rewrite the hash',
          uc_cards.count() == n_uc + 1, f'{n_uc} URL Check cards before, {uc_cards.count()} after')
    check('URL Inspector is no longer a tool of its own',
          'url-info' not in tool_ids() and not page.locator('details.card summary', has_text='URL Inspector').count())
    page.evaluate("location.hash = ''")
    page.wait_for_timeout(400)

    page.evaluate(f"location.hash = '#/t/{UC}'")
    page.wait_for_timeout(800)
    us = page.locator('details.card').last.locator('.card-body')

    def uc_run(value, want_feeds=True, budget=25):
        # Type a URL, press Check, and wait for the feed layer as well as the local one.
        us.locator('input.full').fill(value)
        us.locator('button', has_text='Check').first.click()
        for _ in range(budget):
            page.wait_for_timeout(500)
            if not want_feeds or us.locator('.url-check-feedresult').count() == 1:
                break
        return us.locator('.url-check-out').inner_text().lower()

    us_text = uc_run(NASTY)
    n_find = us.locator('.url-check-finding').count()
    check('url-check: a nasty URL yields a full set of structural findings', n_find >= 7,
          f'{n_find} findings, out={us_text[:120]!r}')
    for label, needle in [
        ('credentials before the @', 'login credentials in the url'),
        ('mixed-script homograph host', 'homograph attack'),
        ('decoded punycode is shown', 'displays as'),
        ('brand in a subdomain, not the domain', 'sits in a subdomain'),
        ('free-registration TLD', 'free-registration domain'),
        ('non-standard port', 'non-standard port 8081'),
        ('plain http', 'plain http, not https'),
        ('double percent-encoding', 'double percent-encoding'),
        ('deep subdomain nesting', 'levels of subdomain'),
    ]:
        check(f'url-check: reports {label}', needle in us_text, f'missing {needle!r}')
    score_badge = us.locator('.url-check-score .badge').first.inner_text().strip()
    check('url-check: scores the nasty URL as high risk',
          score_badge.split('/')[0].isdigit() and int(score_badge.split('/')[0]) >= 45, f'score={score_badge!r}')
    check('url-check: separates the heuristic layer from the fact layer',
          us.locator('.url-check-structural').count() == 1 and 'heuristic' in us_text, us_text[-200:])

    # The merged URL Inspector: the same component breakdown, driven by the same input,
    # now a section of this card. Labels alone are a proxy, so the parsed values are
    # asserted too, and the section must sit under the verdict, since "what is in this
    # link" is only worth reading once "is it safe" has been answered.
    parts_txt = us.locator('.url-check-parts').inner_text().lower()
    check('url-check: the merged breakdown reports protocol, host, path and query',
          us.locator('.url-check-parts').count() == 1
          and all(k in parts_txt for k in ('protocol:', 'host:', 'hostname:', 'path:', 'query to:')),
          parts_txt[:200])
    check('url-check: the breakdown carries the parsed values, not just the labels',
          all(v in parts_txt for v in ('http:', 'xn--pypal-4ve.tk', '8081', '/reset%2fpass')), parts_txt[:200])
    check('url-check: the breakdown sits beneath the verdict, not above it',
          us.evaluate("e => { const v = e.querySelector('.url-check-structural');"
                      " const b = e.querySelector('.url-check-parts');"
                      " return !!(v && b) && !!(v.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) }"))
    # The local layer reads the URL text without opening it.
    check('url-check: never fetches the link it is judging',
          not any('login-verify' in u or 'xn--pypal' in u for u in offsite), str(offsite[-4:])[:160])

    # --- the fact layer: a URL the feed actually lists right now ---
    if sample:
        bad_text = uc_run(sample)
        listed = us.locator('.url-check-feedresult').inner_text().lower()
        check('url-check: a live OpenPhish URL is reported as listed', 'listed by openphish' in listed, listed[:200])
        check('url-check: an exact URL hit is named as an exact URL hit',
              'this exact url is listed' in listed, listed[:200])
        check('url-check: the listing states the age of the feed',
              ' old' in listed and 'entries' in listed, listed[:200])
        check('url-check: a listing reads as a fact, not a score',
              us.locator('.url-check-feedresult .badge.danger').count() == 1, listed[:200])
        # The listing above shows the app has the feed, not that it fetched one. The feed
        # is cached in IndexedDB, so a lookup here is usually answered locally and
        # watching the wire during it says nothing either way. Drive the row's own Refresh
        # button, the one path that must always reach the network, and watch that.
        _pre = len(offsite)
        _op_row = us.locator('.url-check-feed-row', has_text='OpenPhish')
        _refresh = _op_row.locator('button').filter(has_text=re.compile(r'^(Refresh|Download)$'))
        check('url-check: the OpenPhish row offers a refresh', _refresh.count() >= 1,
              f'{_refresh.count()} buttons in {_op_row.count()} rows')
        if _refresh.count():
            _refresh.first.click()
            us.page.wait_for_timeout(6000)
            check('url-check: refreshing really goes to the OpenPhish feed over the network',
                  any('openphish/public_feed' in u for u in offsite[_pre:]),
                  str(offsite[_pre:][-5:])[:200])
        check('url-check: checking a listed URL still never fetches it',
              sample_host == '' or not any(sample_host in u for u in offsite), str(offsite[-4:])[:200])
        check('url-check: the copy-report text carries the listing',
              'openphish' in bad_text, bad_text[:160])

    # A verdict that flags everything is useless, so the clean case is asserted in both
    # layers: no structural findings and no listing.
    clean_text = uc_run('https://example.com/pricing')
    clean_feeds = us.locator('.url-check-feedresult').inner_text().lower()
    check('url-check: an ordinary https URL raises nothing structural',
          us.locator('.url-check-finding').count() == 0 and 'nothing structurally suspicious' in clean_text,
          clean_text[:140])
    check('url-check: an ordinary https URL is not reported as listed',
          'listed by' not in clean_feeds and 'not on' in clean_feeds, clean_feeds[:200])
    check('url-check: a clean answer still names the feed and its age',
          'openphish' in clean_feeds and ' old' in clean_feeds, clean_feeds[:200])

    check('url-check: rejects a non-URL', 'not a valid url' in uc_run('not a url at all', want_feeds=False))
    check('url-check: a non-URL gets no breakdown either', us.locator('.url-check-parts').count() == 0)

    # The 3.6 MB list is opt in, so nothing may pull it on load or during a check.
    check('url-check: the bulk feed is never downloaded unasked',
          not any('phishing-domains-ACTIVE' in u for u in offsite), str([u for u in offsite if 'jsdelivr' in u])[:200])
    rows = us.locator('.url-check-feed-row')
    check('url-check: every feed is listed with its state', rows.count() == 3, f'{rows.count()} rows')
    check('url-check: the undownloaded bulk feed says so, with its size',
          'not downloaded' in rows.nth(1).inner_text().lower() and 'mb' in rows.nth(1).inner_text().lower(),
          rows.nth(1).inner_text()[:160])
    check('url-check: a cached feed shows entry count, size and age',
          re.search(r'\d+ entries.*(kb|mb).*fetched.*old', rows.nth(0).inner_text().lower(), re.S) is not None,
          rows.nth(0).inner_text()[:160])
    check('url-check: a cached feed can be refreshed and deleted',
          rows.nth(0).locator('button', has_text='Refresh').count() == 1
          and rows.nth(0).locator('button', has_text='Delete').count() == 1)

    # --- paste: the verdict must land on the card without opening the tool ---
    PASTE_JS = '''(url) => {
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur()
      const dt = new DataTransfer()
      dt.setData('text/plain', url)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }'''

    def paste_verdict(url):
        # Peers in the code room push their own cards while this runs, so `.feed-item`
        # .last need not be the pasted one. Address the verdict element directly.
        page.evaluate("location.hash = '#/'")
        page.wait_for_timeout(400)
        before = page.locator('.url-check-card').count()
        page.evaluate(PASTE_JS, url)
        # The card is built behind two dynamic imports, so poll rather than guess a
        # delay; a fixed wait turns a slow chunk load into a phantom failure.
        for _ in range(40):
            page.wait_for_timeout(250)
            if page.locator('.url-check-card').count() > before:
                break
        return before, page.locator('.url-check-card').last

    # With the switch off a pasted link must get a button and nothing else, and that
    # button must still produce the full verdict. The mount-all pass above already left a
    # URL Check card in the feed, so scope this to the card this block opened.
    auto = page.locator('.url-check-auto input[type="checkbox"]').last
    check('url-check: pasted links are checked by default', auto.is_checked())
    auto.uncheck()
    page.wait_for_timeout(300)
    _, offv = paste_verdict('https://example.org/quiet')
    check('url-check: with the switch off a pasted link is not checked automatically',
          offv.locator('.url-check-structural').count() == 0
          and offv.locator('button', has_text='Check this link').count() == 1,
          offv.inner_text()[:160])
    offv.locator('button', has_text='Check this link').first.click()
    manual = ''
    for _ in range(30):
        page.wait_for_timeout(500)
        if offv.locator('.url-check-feedresult').count() == 1:
            manual = offv.locator('.url-check-feedresult').inner_text().lower()
            break
    check('url-check: the manual button on a pasted card produces the full verdict',
          offv.locator('.url-check-structural').count() == 1 and 'openphish' in manual,
          manual[:160] or 'no verdict rendered')
    auto.check()
    page.wait_for_timeout(300)

    if sample:
        before, vc = paste_verdict(sample)
        check('pasted link is checked without opening the tool',
              page.locator('.url-check-card').count() == before + 1, f'{before} verdict cards before')
        # The local layer paints before the network answers, which is why the paste is
        # not blocked. Asserted while the feed answer may still be pending.
        check('pasted link shows the instant local verdict first',
              vc.locator('.url-check-structural').count() == 1, 'no structural block on the card')
        verdict = ''
        for _ in range(40):
            if vc.locator('.url-check-feedresult').count() == 1:
                verdict = vc.locator('.url-check-feedresult').inner_text().lower()
                break
            page.wait_for_timeout(500)
        check('pasted known-bad link is reported as listed, on the card',
              'listed by openphish' in verdict, verdict[:200] or 'no verdict rendered')
        check('pasted verdict names the strength of the match',
              'this exact url is listed' in verdict, verdict[:200])

    before, cvc = paste_verdict('https://example.com/pricing')
    check('clean url paste is checked on the card too',
          page.locator('.url-check-card').count() == before + 1, f'{before} verdict cards before')
    # The pasted card deliberately omits the component breakdown the tool now shows,
    # because it pushed the verdict below the fold. Merging URL Inspector into the tool
    # must not quietly bring it back here.
    check('a pasted link stays verdict-first, with no component breakdown',
          cvc.locator('.url-check-parts').count() == 0)
    cverdict = ''
    for _ in range(30):
        if cvc.locator('.url-check-feedresult').count() == 1:
            cverdict = cvc.locator('.url-check-feedresult').inner_text().lower()
            break
        page.wait_for_timeout(500)
    check('pasted clean link is not reported as listed',
          bool(cverdict) and 'listed by' not in cverdict, cverdict[:200] or 'no verdict rendered')
    # The verdict is the whole card. A host/path/query breakdown duplicating the URL Info
    # tool pushes the question a pasted link actually asks (is this listed, by whom, how
    # old is that answer) below the fold, so the link itself is asserted here.
    cpaste = page.locator('.feed-item', has=page.locator('.url-check-card')).last
    check('a pasted link card shows the link itself',
          cpaste.locator('.url-paste-link').count() == 1 and 'example.com/pricing' in cpaste.locator('.url-paste-link').inner_text(),
          cpaste.inner_text()[:160])
    check('a pasted link card no longer repeats the URL Info breakdown',
          'Parsed (never auto-fetched)' not in cpaste.inner_text(), cpaste.inner_text()[:200])
    check('the feed answer is the first thing on a pasted link card, findings below it',
          'url-check-feedresult' in (cvc.evaluate('e => e.firstElementChild ? e.firstElementChild.className : ""') or ''),
          cvc.evaluate('e => e.firstElementChild ? e.firstElementChild.className : "(empty)"'))
    check('the pasted link card still carries the structural reading as the second layer',
          cvc.locator('.url-check-structural').count() == 1, cvc.inner_text()[:160])
    check('the pasted link answer names the feed and its age',
          'entries' in cverdict and ('old' in cverdict or 'listed' in cverdict), cverdict[:200])
    check('pasted clean link still names the feed it was checked against',
          'openphish' in cverdict, cverdict[:200])

    # --- shorten: the one tool that leaves the device ---
    page.evaluate(f"location.hash = '#/t/{tool_id_for('shorten')}'")
    page.wait_for_timeout(800)
    sh = page.locator('details.card').last.locator('.card-body')
    check('shorten: the card says the URL is sent to spoo.me', 'spoo.me' in sh.inner_text().lower())

    # The local gate has to reject before anything leaves the device.
    pre_reqs = len(offsite)
    sh.locator('input.full').fill('definitely not a url')
    sh.locator('button', has_text='Shorten').first.click()
    page.wait_for_timeout(500)
    check('shorten: rejects a non-URL locally', 'not a url' in sh.locator('.shorten-status').inner_text().lower(),
          sh.locator('.shorten-status').inner_text()[:110])
    check('shorten: invalid input never reaches the network', len(offsite) == pre_reqs, str(offsite[pre_reqs:])[:140])

    err_before = len(logs)
    sh.locator('input.full').fill('https://example.com/a/long/path/worth/shortening?utm_source=e2e')
    sh.locator('button', has_text='Shorten').first.click()
    waited = 0
    while waited < 20000:
        st = sh.locator('.shorten-status').inner_text().strip()
        if st and 'sending' not in st.lower():
            break
        page.wait_for_timeout(500)
        waited += 500
    st = sh.locator('.shorten-status').inner_text().strip()
    link = sh.locator('.shorten-short')
    got = link.count() > 0 and link.first.inner_text().strip().startswith('http')
    check('shorten: the request actually goes to spoo.me',
          any('spoo.me' in u for u in offsite[pre_reqs:]), str(offsite[pre_reqs:])[:140])
    # Success or a rendered failure; never a spinner that never resolves.
    check('shorten: ends in a real short link or a graceful message', got or bool(st), f'status={st!r} link={got}')
    if got:
        check('shorten: the short link points at spoo.me', 'spoo.me' in link.first.inner_text())
        check('shorten: the session history records it', sh.locator('.shorten-history-item').count() >= 1)
    else:
        # Offline, rate limited or refused: the card must explain it in words.
        check('shorten: an offline provider is explained in the card', bool(st) and 'sending' not in st.lower(), f'status={st!r}')
    net_errs = [l for l in logs[err_before:] if l.startswith('pageerror:')]
    check('shorten: the network path raises no unhandled error', not net_errs, ' | '.join(net_errs[:2])[:160])
    page.remove_listener('request', _watch_request)
    # =================== end url check + shorten block ===================

    # ===================== subtitles (driven, exact output) =====================
    # Self-contained block; nothing above is restructured. The tool is pure computation on
    # text, so the assertions are on exact bytes: a known SRT goes in and the WebVTT that
    # comes back is compared character for character, which pins the comma-to-dot
    # separator change.
    SUB_SRT = ('1\n'
               '00:00:01,000 --> 00:00:02,500\n'
               'Hello there\n'
               '\n'
               '3\n'                      # SRT numbering is not always sequential
               '00:00:04,250 --> 00:00:06,000\n'
               'General Kenobi\n')
    SUB_VTT = ('WEBVTT\n'
               '\n'
               '00:00:01.000 --> 00:00:02.500\n'
               'Hello there\n'
               '\n'
               '00:00:04.250 --> 00:00:06.000\n'
               'General Kenobi\n')
    # Same cues, every timing pushed 2.5s later.
    SUB_VTT_SHIFTED = ('WEBVTT\n'
                       '\n'
                       '00:00:03.500 --> 00:00:05.000\n'
                       'Hello there\n'
                       '\n'
                       '00:00:06.750 --> 00:00:08.500\n'
                       'General Kenobi\n')

    subs_before = len(logs)
    page.evaluate("location.hash = '#/t/subtitles'")
    page.wait_for_timeout(700)
    sub = page.locator('details.card').last
    check('subtitles: the card mounts', sub.locator('.subs-in').count() == 1)

    sub.locator('.subs-in').fill(SUB_SRT)
    sub.locator('.subs-format').select_option('vtt')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    vtt = sub.locator('.subs-out').input_value()
    check('subtitles: SRT converts to exactly the expected WebVTT', vtt == SUB_VTT, repr(vtt)[:220])
    check('subtitles: the SRT comma separator is gone from the WebVTT',
          ',' not in vtt.split('\n')[2], repr(vtt.split('\n')[2]))
    check('subtitles: the WebVTT header is present', vtt.startswith('WEBVTT\n\n'), repr(vtt[:20]))
    check('subtitles: non-sequential SRT numbering is not carried into the WebVTT',
          '\n3\n' not in vtt and not vtt.split('\n')[2].strip().isdigit(), repr(vtt)[:180])
    rep = sub.locator('.subs-report').inner_text()
    check('subtitles: the report counts both cues and names the source format',
          '2 cues' in rep and 'SubRip' in rep, rep[:120])
    check('subtitles: a clean file reports no problems', sub.locator('.subs-issue').count() == 0,
          sub.locator('.subs-issues').inner_text()[:120])
    check('subtitles: a download is offered', sub.locator('.subs-download').count() == 1
          and 'hidden' not in (sub.locator('.subs-download').get_attribute('class') or ''))

    # Shift: same cues, both timings moved by +2.5s, still exact.
    sub.locator('.subs-offset').fill('2.5')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    shifted = sub.locator('.subs-out').input_value()
    check('subtitles: a +2.5s shift moves every timing by exactly that much',
          shifted == SUB_VTT_SHIFTED, repr(shifted)[:220])

    # A negative shift may not invent a negative timestamp.
    sub.locator('.subs-offset').fill('-30')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    clamped = sub.locator('.subs-out').input_value()
    check('subtitles: a negative shift clamps at zero instead of going negative',
          '00:00:00.000 --> 00:00:00.000' in clamped and '-00' not in clamped, repr(clamped)[:200])

    # Frame-rate rescale, back at zero offset: 25 fps timings against 23.976 fps video.
    sub.locator('.subs-offset').fill('0')
    sub.locator('.subs-rate').select_option(label='25 fps file, 23.976 fps video')
    page.wait_for_timeout(200)
    check('subtitles: the fps preset fills in the multiplier',
          abs(float(sub.locator('.subs-factor').input_value()) - 25 / 23.976) < 1e-5,
          sub.locator('.subs-factor').input_value())
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    scaled = sub.locator('.subs-out').input_value()
    check('subtitles: rescaling stretches the timings by the factor',
          '00:00:01.043 --> 00:00:02.607' in scaled, repr(scaled)[:200])

    # Round trip back to SRT: renumbered from 1, comma separator restored.
    sub.locator('.subs-rate').select_option(label='Keep the timings as they are')
    sub.locator('.subs-format').select_option('srt')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    srt = sub.locator('.subs-out').input_value()
    check('subtitles: writing SRT renumbers from 1 and restores the comma',
          srt == SUB_SRT.replace('\n3\n', '\n2\n'), repr(srt)[:220])

    # Plain transcript: text only, no timings, no markup.
    sub.locator('.subs-in').fill(SUB_SRT.replace('General Kenobi', 'General <i>Kenobi</i>'))
    sub.locator('.subs-format').select_option('txt')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    txt = sub.locator('.subs-out').input_value()
    check('subtitles: the transcript drops timings and inline tags',
          txt == 'Hello there\nGeneral Kenobi\n', repr(txt)[:200])

    # Malformed input has to be reported rather than swallowed, since a file that will
    # not parse is the case the tool exists to diagnose.
    sub.locator('.subs-in').fill('1\n00:00:01,000 --> 0:0:xx\nbroken timing\n\n'
                                 '2\n00:00:09,000 --> 00:00:08,000\nbackwards\n')
    sub.locator('.subs-format').select_option('vtt')
    sub.locator('button', has_text='Convert').first.click()
    page.wait_for_timeout(300)
    problems = sub.locator('.subs-issues').inner_text().lower()
    check('subtitles: an unreadable timestamp is reported with its line number',
          'unreadable timestamp' in problems and 'line 2' in problems, problems[:160])
    check('subtitles: a cue that ends before it starts is reported',
          'ends before it starts' in problems, problems[:160])
    check('subtitles: the good cue still survives a broken neighbour',
          '00:00:09.000 --> 00:00:08.000' in sub.locator('.subs-out').input_value(),
          sub.locator('.subs-out').input_value()[:120])

    # The file input is the other way in, and it also names the download. Fed as a real
    # File so the reader path runs alongside the paste path.
    sub.locator('.subs-file').set_input_files(files=[{
        'name': 'episode.01.srt', 'mimeType': 'text/plain', 'buffer': SUB_SRT.encode()}])
    page.wait_for_timeout(400)
    check('subtitles: a loaded file lands in the source box',
          sub.locator('.subs-in').input_value() == SUB_SRT, repr(sub.locator('.subs-in').input_value())[:160])
    check('subtitles: loading a file converts it straight away',
          sub.locator('.subs-out').input_value() == SUB_VTT, repr(sub.locator('.subs-out').input_value())[:200])
    dl_href = sub.locator('.subs-download').get_attribute('href') or ''
    check('subtitles: the download is a same-origin blob, not a remote fetch',
          dl_href.startswith('blob:'), dl_href[:60])
    check('subtitles: the download keeps the loaded file name with the new extension',
          sub.locator('.subs-download').get_attribute('download') == 'episode.01.vtt',
          str(sub.locator('.subs-download').get_attribute('download')))

    subs_bad = [l for l in logs[subs_before:]
                if 'trustedhtml' in l.lower() or 'trusted type' in l.lower()
                or 'content security policy' in l.lower() or l.startswith('pageerror:')]
    check('subtitles: no CSP, Trusted Types or runtime error while converting',
          not subs_bad, ' | '.join(subs_bad[:2])[:200])
    # =================== end subtitles block ===================


    # ===================== OCR quality: small text keeps its punctuation =====================
    # A browser screenshot whose address bar held a dotted hostname came back with the dots
    # gone. At 96 DPI the period between two labels is one or two pixels, and it is the
    # first feature an LSTM drops when the bitmap is handed over at native size.
    #
    # The fixture is generated here rather than committed: a real screenshot carries
    # personal data that does not belong in a public repository, and a committed binary is
    # opaque in a diff. This canvas reproduces the two properties that made that image
    # hard, and nothing else.
    #
    # Driven through the OCR tool's own file input, so it exercises the shipped path:
    # preprocessing, the shared Trusted Types worker, and recognition. The tool rendered
    # fine while it was dropping dots, so a rendered card is not evidence.
    ocr_png = base64.b64decode(page.evaluate('''async () => {
      // Synthetic on purpose: a real screenshot carries an address bar, form fields and
      // an email address, none of which belongs in a public repository. The two properties
      // that made the original hard are reproduced instead. Small glyphs (13px, about what
      // an address bar renders at 96 DPI, where a period between two hostname labels is
      // one or two pixels), and mixed polarity, light text on dark chrome above and dark
      // text on a light page below, which rules out one global threshold for the frame.
      const c = document.createElement('canvas'); c.width = 760; c.height = 420
      const g = c.getContext('2d')
      g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 760, 420)
      g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, 760, 34)
      // 'sans-serif' rather than 'system-ui': the runner and a dev machine resolve
      // system-ui to different faces, and the fixture must not depend on which.
      g.font = '13px sans-serif'; g.textBaseline = 'middle'
      // No path after the host. The assertion is about the separators between labels
      // surviving, and a trailing '/login' only adds a slash-and-l ambiguity that is not
      // the property under test; it is also what made this fail on the runner.
      g.fillStyle = '#e8e8e8'; g.fillText('docs.example-site.org', 96, 17)
      // a mid-grey block, standing in for the photo that occupied half the reported image
      g.fillStyle = '#8a8a8a'; g.fillRect(470, 34, 290, 386)
      g.fillStyle = '#ffffff'; g.fillRect(24, 150, 410, 40)
      g.strokeStyle = '#c9c9c9'; g.strokeRect(24, 150, 410, 40)
      g.fillStyle = '#111111'; g.fillText('support.example-site.org', 38, 170)
      g.font = 'bold 22px serif'
      g.fillText('Reset your password', 24, 80)
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      const buf = new Uint8Array(await blob.arrayBuffer())
      let out = ''
      for (let i = 0; i < buf.length; i++) out += String.fromCharCode(buf[i])
      return btoa(out)
    }'''))
    ocr_fx = os.path.join(tempfile.gettempdir(), 'urletc-ocr-dotted.png')
    io.open(ocr_fx, 'wb').write(ocr_png)
    page.evaluate(f"location.hash = '#/t/{tool_id_for('ocr')}'")
    page.wait_for_timeout(800)
    ocr_card = page.locator('details.card').last
    ocr_before = len(logs)
    ocr_card.locator('input[type=file]').set_input_files(ocr_fx)
    # Same shape as the feed OCR wait: the <pre> carries the placeholder, then progress,
    # then the result, so poll for text that is none of the first two.
    shot_text = ''
    for _ in range(60):
        page.wait_for_timeout(1000)
        t_ = (ocr_card.locator('pre').first.inner_text() or '').strip()
        if t_ and '%' not in t_ and t_ != 'extracted text' and not t_.lower().startswith(('recognizing', 'loading')):
            shot_text = t_
            break
        shot_text = t_
    low = shot_text.lower()
    check('OCR reads the rendered page at all', len(low) > 20, repr(shot_text[:120]))
    # The regression itself. Both halves carry a dotted hostname, one in light-on-dark
    # chrome and one in a dark-on-light field, so a fix that rescues only one polarity
    # still fails here.
    check('OCR keeps the dots in a hostname on dark chrome',
          'docs.example-site.org' in low, repr(shot_text[:200]))
    check('OCR does not run hostname labels together',
          'docsexample' not in low and 'examplesite' not in low, repr(shot_text[:200]))
    check('OCR keeps the dots in a hostname on a light background',
          'support.example-site.org' in low, repr(shot_text[:200]))
    ocr_bad = [l for l in logs[ocr_before:]
               if 'trustedhtml' in l.lower() or 'trustedscript' in l.lower()
               or 'trusted type' in l.lower() or 'content security policy' in l.lower()
               or l.startswith('pageerror:')]
    check('OCR preprocessing raises no CSP, Trusted Types or runtime error',
          not ocr_bad, ' | '.join(ocr_bad[:2])[:200])
    # =================== end OCR quality block ===================


    # Heavy features build a Worker, so check each kind can be constructed under the live
    # CSP rather than inferring it from the UI having rendered.
    check('OCR worker shim is reachable and parses',
          page.evaluate("async () => { const r = await fetch('/tesseract/worker-tt.js');"
                        " return r.ok && (await r.text()).includes('createPolicy') }"))

    # =================== ICE configuration ===================
    # Trystero defaults to four STUN servers and concatenates turnConfig onto them, so the
    # earlier config produced six entries and Firefox warned on every peer connection:
    # "WebRTC: Using five or more STUN/TURN servers slows down discovery", 20 to 25 lines
    # per page, with up to four rooms open at once. Passing rtcConfig.iceServers replaces
    # that default instead of adding to it, which is what makes the count controllable.
    # Read the argument the app hands RTCPeerConnection rather than the source, since the
    # source can set the field while Trystero still wins the merge.
    icx = browser.new_context()
    icp = icx.new_page()
    icp.add_init_script("""
      window.__ice = [];
      const RealPC = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(RealPC, {
        construct(target, args) {
          const cfg = args[0] || {};
          window.__ice.push(Array.isArray(cfg.iceServers) ? cfg.iceServers : null);
          return new target(...args);
        },
      });
    """)
    icp.goto(f'{BASE}/#/join/{OWN_CODE}')
    icp.wait_for_selector('.composer', timeout=20000)
    ice_lists = []
    for _ in range(60):
        icp.wait_for_timeout(500)
        ice_lists = icp.evaluate('window.__ice')
        if len(ice_lists) >= 2:
            break
    check('the app builds peer connections at all (ICE probe saw a constructor call)',
          len(ice_lists) >= 1, f'{len(ice_lists)} RTCPeerConnection constructions observed')

    def ice_urls(entries):
        out = []
        for e in entries or []:
            u = e.get('urls')
            out.extend([u] if isinstance(u, str) else (u or []))
        return out

    inherited = [l for l in ice_lists if l is None]
    check('every peer connection carries an explicit ICE list, never the library default',
          not inherited, f'{len(inherited)} of {len(ice_lists)} were constructed with no iceServers')
    worst = max((ice_urls(l) for l in ice_lists if l), key=len, default=[])
    check('no peer connection is given five or more ICE server URLs',
          len(worst) < 5, f'{len(worst)} urls: {worst}')
    check('a STUN server survives the trim, so peers can still find a route',
          any(u.startswith('stun:') for u in worst), str(worst))
    # A relay that answers Allocate with "400 TURN allocate error" relays nothing while
    # still costing every connection a full gathering timeout and a slot in the count
    # above. Any TURN entry here has to be one expected to work, so the retired openrelay
    # credentials must stay out.
    check('the retired openrelay TURN endpoint is not in the ICE list',
          not any('openrelay' in u for u in worst), str(worst))
    icx.close()

    # =================== peer to peer file transfer ===================
    # Two real browser contexts, a real code room over the real relays, and a real
    # multi-chunk image. The assertion is on the decoded image on the far side rather than
    # on a card having appeared, which is all the earlier coverage checked.
    FILE_CODE = 'x' + os.urandom(3).hex()
    SEND_PNG = os.path.join(SNAP, f'wt-send-{FILE_CODE}.png')
    DROP_PNG = os.path.join(SNAP, f'wt-drop-{FILE_CODE}.png')
    IMG_W, IMG_H = 900, 700
    DROP_W, DROP_H = 1700, 1300  # ~6 MB, so cutting the sender lands mid-file

    def make_png(path, w, h):
        """An incompressible PNG, so the file is many 64 KiB chunks rather than one."""
        import zlib, struct
        rnd = os.urandom(w * h * 3)
        raw = bytearray()
        for y in range(h):
            raw.append(0)
            raw += rnd[y * w * 3:(y + 1) * w * 3]

        def ch(tag, data):
            body = tag + data
            return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)

        png = (b'\x89PNG\r\n\x1a\n'
               + ch(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
               + ch(b'IDAT', zlib.compress(bytes(raw), 1)) + ch(b'IEND', b''))
        io.open(path, 'wb').write(png)
        return len(png)

    send_bytes = make_png(SEND_PNG, IMG_W, IMG_H)
    make_png(DROP_PNG, DROP_W, DROP_H)

    def join_room(label):
        c = browser.new_context()
        c.add_init_script(VISIBILITY)
        pg = c.new_page()
        pg.goto(f'{BASE}/#/join/{FILE_CODE}')
        pg.wait_for_selector('.composer', timeout=30000)
        return c, pg

    def feed_text(pg):
        return pg.locator('.feed').inner_text()

    def poll(fn, seconds, step=0.5):
        for _ in range(int(seconds / step)):
            v = fn()
            if v:
                return v
            page.wait_for_timeout(int(step * 1000))
        return None

    ctx_a, pg_a = join_room('A')
    ctx_b, pg_b = join_room('B')
    paired = poll(lambda: 'Secure channel established' in feed_text(pg_a)
                  and 'Secure channel established' in feed_text(pg_b), 150)
    check('two contexts in one code room reach a secure channel', bool(paired),
          f'A: {feed_text(pg_a)[-120:]!r} B: {feed_text(pg_b)[-120:]!r}')

    # "Secure channel established" prints when the handshake completes, but the send path
    # asks reachableCount(), which is driven by the roster. On a slow runner the click can
    # land in the gap between the two and sendFileAll finds nobody, which is how CI failed
    # here with B's feed ending at the channel message and no file activity, while the same
    # assertions passed locally. Wait for A to report a reachable peer, the condition the
    # send itself tests.
    reachable_a = poll(lambda: 'connected' in (pg_a.locator('.topbar .badge').inner_text() or ''), 60) if paired else None
    check('the sender counts the peer as reachable before sending', bool(reachable_a),
          f"A chip={pg_a.locator('.topbar .badge').inner_text()!r}" if paired else 'not paired')

    def transfer_diag():
        # Both sides plus A's chip. A diagnostic showing only B cannot distinguish "A
        # never sent" from "B never received".
        return (f"A chip={pg_a.locator('.topbar .badge').inner_text()!r} "
                f"A feed={feed_text(pg_a)[-200:]!r} B feed={feed_text(pg_b)[-200:]!r}")

    if paired and reachable_a:
        pg_a.locator('input[type=file][accept="image/*"]').set_input_files(SEND_PNG)
        pg_a.wait_for_selector('.card button:has-text("Send to devices")', timeout=20000)
        pg_a.locator('.card button', has_text='Send to devices').last.click()
        offered = poll(lambda: 'Incoming file' in feed_text(pg_b), 90)
        check('the receiving device is told a file is coming', bool(offered), transfer_diag())
        landed = poll(lambda: pg_b.locator('.card img.preview').count() > 0, 180)
        check('a sent image actually arrives on the other device', bool(landed), transfer_diag())
        if landed:
            # A truncated transfer produces a card with a broken <img>, so the assertion
            # is on the decoded pixels: matching dimensions mean every chunk was
            # decrypted and reassembled in order.
            dims = pg_b.locator('.card img.preview').last.evaluate(
                'e => ({w: e.naturalWidth, h: e.naturalHeight, done: e.complete})')
            check('the received image decodes to the bytes that were sent',
                  dims['done'] and dims['w'] == IMG_W and dims['h'] == IMG_H,
                  f'{dims} expected {IMG_W}x{IMG_H} from {send_bytes} bytes')
            size_line = pg_b.locator('.card', has=pg_b.locator('img.preview')).last.inner_text()
            check('the received file is reported at its real size',
                  f'{round(send_bytes / 1024)} KB' in size_line, size_line[:120])
        b_errs = poll(lambda: 'Failed to decrypt' in feed_text(pg_b), 1)
        check('no chunk failed to decrypt on the way', not b_errs, feed_text(pg_b)[-160:])

        # An interrupted transfer has to terminate and say so. A half-file held with no
        # card and no error still occupies a slot against the sixteen-file ceiling, and
        # enough of them make every later file be refused.
        ctx_c, pg_c = join_room('C')
        met = poll(lambda: 'Secure channel established' in feed_text(pg_c), 150)
        check('a third device joins the same room', bool(met), feed_text(pg_c)[-120:])
        if met:
            drop_name = os.path.basename(DROP_PNG)
            pg_c.locator('input[type=file][accept="image/*"]').set_input_files(DROP_PNG)
            pg_c.wait_for_selector('.card button:has-text("Send to devices")', timeout=20000)
            pg_c.locator('.card button', has_text='Send to devices').last.click()
            # Wait for this file's offer by name. Waiting for the words "Incoming file"
            # matches the transfer that already succeeded above and would cut the sender
            # before it had sent anything.
            offered_drop = poll(lambda: drop_name in feed_text(pg_b), 90, step=0.1)
            check('the second offer is seen before its sender is cut', bool(offered_drop),
                  feed_text(pg_b)[-200:])
            ctx_c.close()  # sender vanishes mid-file
            # The assertion is that the receive reaches an end: either the repair round
            # completed it, or it was abandoned in the feed. Silence is the failure mode
            # being guarded, since a half-file that sits there holds one of the sixteen
            # concurrent-receive slots for the life of the page.
            def drop_resolved():
                txt = feed_text(pg_b)
                if drop_name in txt and 'did not finish' in txt:
                    return 'abandoned'
                if pg_b.locator('.card', has_text=drop_name).locator('img.preview').count() > 0:
                    return 'completed'
                return None

            outcome = poll(drop_resolved, 60)
            check('a transfer whose sender vanishes reaches an end instead of hanging silently',
                  bool(outcome), feed_text(pg_b)[-250:])
            if outcome == 'abandoned':
                check('the abandoned transfer names the file and how far it got',
                      drop_name in feed_text(pg_b) and 'pieces' in feed_text(pg_b),
                      feed_text(pg_b)[-250:])
    # =============== a backgrounded tab reports what it missed ===============
    # Rides on the pair above instead of opening its own. The scarce thing here is a real
    # handshake between two contexts over real relays, and this needs exactly the one that
    # is already standing.
    if paired and reachable_a:
        # Nearby is a second rendezvous tier every page in this run shares, since it is
        # derived from the public IP. A stranger from an earlier block finishing its
        # handshake with B mid-block is a real arrival and a real mark, and it would land
        # inside the own-send control below. Off for B only, through the event the Settings
        # toggle dispatches, so the code room is the only way anything reaches B from here.
        pg_b.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
        pg_b.wait_for_timeout(500)

        base_title = pg_b.title()
        base_icon = icon_href(pg_b)
        check('the tab title carries no mark while the tab is in front', title_count(pg_b) == 0, base_title)

        pg_b.evaluate('() => window.__background(true)')
        pg_a.locator('.composer textarea').fill('background one')
        pg_a.locator('.composer textarea').press('Enter')
        check('a peer message reaches the backgrounded tab', bool(poll(lambda: 'background one' in feed_text(pg_b), 60)),
              feed_text(pg_b)[-160:])
        n1 = poll(lambda: title_count(pg_b), 10) or 0
        check('a peer message marks the title of a backgrounded tab', n1 >= 1, pg_b.title())
        check('the mark leaves the original title intact behind the count',
              pg_b.title().endswith(f') {base_title}'), pg_b.title())
        check('the favicon swaps while the tab is marked', icon_href(pg_b) == '/icon-alert.svg', str(icon_href(pg_b)))

        pg_a.locator('.composer textarea').fill('background two')
        pg_a.locator('.composer textarea').press('Enter')
        check('a second peer message reaches the backgrounded tab', bool(poll(lambda: 'background two' in feed_text(pg_b), 60)),
              feed_text(pg_b)[-160:])
        n2 = poll(lambda: title_count(pg_b) > n1 and title_count(pg_b), 10) or title_count(pg_b)
        check('a second event raises the count instead of repeating one mark', n2 > n1, f'{n1} then {n2}')

        # Focus is the second way back, and it has to clear on its own: a window manager can
        # hand a tab focus without the platform ever having reported it hidden. Driven here
        # while the page still reports hidden, so the visibility path cannot stand in for it.
        pg_b.evaluate("() => window.dispatchEvent(new Event('focus'))")
        check('window focus clears the mark by itself', pg_b.title() == base_title, pg_b.title())

        # The negative control. Every feed item goes through one append point, the composer's
        # own card included, so a mark hung there would count the user typing to themselves.
        pg_b.locator('.composer textarea').fill('a message of my own')
        pg_b.locator('.composer textarea').press('Enter')
        check('the backgrounded tab really did send its own message',
              bool(poll(lambda: 'a message of my own' in feed_text(pg_b), 20)), feed_text(pg_b)[-160:])
        check('sending your own message never marks the tab', title_count(pg_b) == 0, pg_b.title())

        pg_a.locator('.composer textarea').fill('background three')
        pg_a.locator('.composer textarea').press('Enter')
        poll(lambda: 'background three' in feed_text(pg_b), 60)
        check('the title marks again after an earlier mark was cleared',
              bool(poll(lambda: title_count(pg_b) >= 1, 10)), pg_b.title())
        pg_b.evaluate('() => window.__background(false)')
        check('coming back restores the exact title index.html shipped', pg_b.title() == base_title, pg_b.title())
        check('coming back restores the original favicon', icon_href(pg_b) == base_icon, str(icon_href(pg_b)))

    ctx_a.close()
    ctx_b.close()

    # =================== a screen share takes the stage ===================
    # The stage is capped at the feed column, so a screen share that arrives unexpanded is
    # a thumbnail behind a control most people never find. Real peers and a real media
    # track, because the receiver reads {kind} off the stream metadata and an unlabelled
    # video track is treated as a camera, which must not expand anything.
    SCREEN_CODE = 's' + os.urandom(3).hex()
    # Only the OS picker is replaced; headless has no display to grant. Everything after
    # it (publish, transport, metadata, the receiving stage) is the shipped path.
    FAKE_SCREEN = """
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas'); c.width = 640; c.height = 360
        const g = c.getContext('2d')
        setInterval(() => {
          g.fillStyle = '#204060'; g.fillRect(0, 0, 640, 360)
          g.fillStyle = '#ffffff'; g.fillRect((Date.now() / 20) % 600, 0, 40, 360)
        }, 100)
        return c.captureStream(12)
      }
    """

    def theater(pg):
        return pg.evaluate("document.documentElement.classList.contains('stage-max')")

    # The newest screen tile has decoded video: its playhead has moved.
    PAINTS = ("() => { const v = [...document.querySelectorAll('.tiles .stage-tile.kind-screen video')].pop();"
              " return !!v && v.currentTime > 0.5 }")
    PAINTS_DIAG = ("() => [...document.querySelectorAll('.tiles video.tile')].map(v => ({ t: v.currentTime,"
                   " paused: v.paused, tracks: v.srcObject ? v.srcObject.getTracks().map(k => k.kind + (k.muted ? '/muted' : '')) : [] }))")

    sctx_a = browser.new_context()
    sctx_a.add_init_script(FAKE_SCREEN)
    sctx_b = browser.new_context()
    sctx_b.add_init_script(VISIBILITY)
    sh_a, sh_b = sctx_a.new_page(), sctx_b.new_page()
    for _pg in (sh_a, sh_b):
        _pg.goto(f'{BASE}/#/join/{SCREEN_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
    # B spends this section in the background, so the handshake and the share are both
    # things it missed. Backgrounded before anything else, and before the code room is even
    # joined: with warm relays the handshake lands in the first couple of seconds, and a
    # peer that arrives while the tab is in front is correctly not marked.
    sh_base_title = sh_b.title()
    sh_b.evaluate('() => window.__background(true)')
    # Nearby is the other way a peer can arrive, and leaving it on makes the source of a
    # mark ambiguous. The wait is for the listener: mountConsole registers it past an await,
    # so it can still be missing at the moment the composer appears.
    sh_b.wait_for_timeout(2000)
    sh_b.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
    sh_paired = poll(lambda: 'Secure channel established' in sh_a.locator('.feed').inner_text()
                     and 'Secure channel established' in sh_b.locator('.feed').inner_text(), 150)
    check('the two screen-share contexts reach a secure channel', bool(sh_paired),
          f"A: {sh_a.locator('.feed').inner_text()[-120:]!r} B: {sh_b.locator('.feed').inner_text()[-120:]!r}")
    sh_reach = poll(lambda: 'connected' in (sh_a.locator('.topbar .badge').inner_text() or ''), 60) if sh_paired else None
    check('the sharing device counts the peer as reachable', bool(sh_reach),
          f"A chip={sh_a.locator('.topbar .badge').inner_text()!r}" if sh_paired else 'not paired')
    if sh_paired and sh_reach:
        check('a peer joining marks the title of a backgrounded tab',
              bool(poll(lambda: title_count(sh_b) >= 1, 30)), sh_b.title())
        before_share = title_count(sh_b)
        share_btn = sh_a.locator('.composer .bar button[title^="Share your screen"]')
        share_btn.click()
        arrived = poll(lambda: sh_b.locator('.tiles .stage-tile').count() > 0, 90)
        check('a peer screen share arrives as a stage tile', bool(arrived),
              sh_b.locator('.feed').inner_text()[-160:])
        # A tile is not a picture. These two devices met in the nearby room and the code room,
        # and B then left nearby, which is the sequence where a connection shared across rooms
        # lost the answer to the share: the tile appeared and never painted a frame.
        check('the arriving screen share paints frames', bool(arrived) and bool(poll(lambda: sh_b.evaluate(PAINTS), 15)),
              str(sh_b.evaluate(PAINTS_DIAG)))
        check('a screen share starting marks the backgrounded tab too',
              bool(arrived) and bool(poll(lambda: title_count(sh_b) > before_share, 15)),
              f'{before_share} then {title_count(sh_b)}')
        sh_b.evaluate('() => window.__background(false)')
        check('the backgrounded receiver restores its title on return',
              sh_b.title() == sh_base_title, sh_b.title())
        check('sharing your own screen expands the stage', theater(sh_a))
        # The screen's video track is not a camera: "Turn your camera off" on a screen share
        # blanked the screen for every viewer.
        check('a screen share raises no camera or microphone toggle',
              not sh_a.locator('.composer .bar button[title*="your camera o"]').is_visible()
              and not sh_a.locator('.composer .bar button[title*="Mute your microphone"]').is_visible())
        check('an arriving screen share expands the receiving stage', bool(arrived) and theater(sh_b))
        check('the arriving screen share is the spotlight', sh_b.locator('.stage-tile.spot').count() == 1)
        # The class is set past the button, so the button has to be told; otherwise it
        # keeps offering "Expand" on an already expanded stage.
        check('the expand control reads as shrink once a share expanded the stage',
              sh_b.locator('.tiles-head button[title*="Shrink the stage"]').count() == 1)
        # Collapsing the tiles of an expanded stage used to leave it expanded over hidden
        # tiles with the feed hidden too: an empty window.
        sh_b.locator('.tiles-head button[title*="Collapse"]').click()
        check('collapsing an expanded stage gives the window back to the feed',
              bool(poll(lambda: not theater(sh_b) and sh_b.locator('.feed').is_visible(), 5)),
              'stage-max=%s feed=%s' % (theater(sh_b), sh_b.locator('.feed').is_visible()))
        sh_a.locator('.composer .bar button[title*="Stop sharing"]').click()
        ended = poll(lambda: sh_b.locator('.tiles .stage-tile').count() == 0, 60)
        check('the tile goes when the share stops', bool(ended), sh_b.locator('.feed').inner_text()[-160:])
        check('the receiving stage shrinks back when the share ends', bool(ended) and not theater(sh_b))
        check('the sharing stage shrinks back too', not theater(sh_a))

        # Shrinking by hand while the share runs is obeyed. Expanding by hand again and then
        # ending the share releases the stage anyway: with no video left, an expanded stage
        # would be an empty head over a hidden feed.
        share_btn.click()
        again = poll(lambda: sh_b.locator('.tiles .stage-tile').count() > 0, 90)
        check('the second screen share paints frames too', bool(again) and bool(poll(lambda: sh_b.evaluate(PAINTS), 15)),
              str(sh_b.evaluate(PAINTS_DIAG)))
        expanded_again = bool(again) and theater(sh_b)
        check('a second screen share expands the stage again', expanded_again)
        # The collapse above outlived the first share, so this share would expand a stage
        # with its tiles still hidden: blank for this viewer alone.
        check('a share arriving after a collapse shows its tile',
              bool(again) and sh_b.locator('.tiles .stage-tile').first.is_visible())
        # The shrink control only exists once something expanded the stage, so the two
        # assertions below are reported rather than clicked into a timeout that would
        # abort every section after this one.
        if expanded_again:
            sh_b.locator('.tiles-head button[title*="Shrink the stage"]').click()
            sh_b.wait_for_timeout(200)
            check('shrinking while the share runs is obeyed', not theater(sh_b))
            sh_b.locator('.tiles-head button[title*="Expand the stage"]').click()
            sh_b.wait_for_timeout(200)
            sh_a.locator('.composer .bar button[title*="Stop sharing"]').click()
            poll(lambda: sh_b.locator('.tiles .stage-tile').count() == 0, 60)
            check('the last video ending releases even an expansion set by hand', not theater(sh_b))
        else:
            check('shrinking while the share runs is obeyed', False, 'the stage never expanded')
            check('the last video ending releases even an expansion set by hand', False,
                  'the stage never expanded')
            if again:
                sh_a.locator('.composer .bar button[title*="Stop sharing"]').click()
    sctx_a.close()
    sctx_b.close()

    # =================== a connection that fails says so ===================
    # Three contexts in one code room over the real relays. A and B connect normally, so
    # the 'connected' badge below comes out of a real handshake. C's WebRTC is confined to
    # a relay while none is configured, which is the symmetric or carrier-grade NAT case
    # the copy names and the one failure a headless run can produce faithfully: the ICE
    # agent gathers nothing, no candidate pair can form, and Trystero's handshake with a
    # peer it found on a relay times out. Nothing here sets a class or a word by hand.
    #
    # The other failure branch, a connection that was up and then broke, is not forced
    # here: every way of stopping a peer from Playwright (closing the page, closing its
    # RTCPeerConnection) shuts the transport down gracefully, which is a departure and is
    # reported as one. Measured in Chromium: about 15s of consent failure reaches 'failed',
    # and Trystero drops the peer 5s after 'disconnected', so even an abrupt end is a peer
    # that left before it is a peer that broke.
    FAIL_CODE = 'c' + os.urandom(3).hex()
    RELAY_ONLY = """
      const RealPC = window.RTCPeerConnection;
      window.RTCPeerConnection = new Proxy(RealPC, {
        construct(target, args) {
          const cfg = Object.assign({}, args[0] || {});
          cfg.iceServers = [];
          cfg.iceTransportPolicy = 'relay';
          return new target(cfg, ...args.slice(1));
        },
      });
    """

    def fail_join(ctx):
        pg = ctx.new_page()
        pg.goto(f'{BASE}/#/join/{FAIL_CODE}')
        pg.wait_for_selector('.composer', timeout=30000)
        # Nearby is a second rendezvous tier every page in this run shares, and a peer
        # reachable on it renders under nearby rather than under the code room. The wait is
        # for the listener: mountConsole registers it past an await, so it can still be
        # missing at the moment the composer appears.
        pg.wait_for_timeout(2000)
        pg.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
        return pg

    def chip_of(pg):
        return pg.evaluate("() => { const b = document.querySelector('.topbar .badge');"
                           " return b ? [b.textContent, b.className] : ['', ''] }")

    def peer_states(pg):
        # textContent, not inner_text: the sidebar is collapsed by default and an
        # assertion about a word must not turn into an assertion about the drawer.
        return pg.evaluate("() => [...document.querySelectorAll('.peers .peer')].map("
                           "p => p.querySelector('.peer-state').textContent)")

    def sys_lines(pg):
        return pg.evaluate("() => [...document.querySelectorAll('.feed .sys')].map(s => s.textContent)")

    fctx_a, fctx_b = browser.new_context(), browser.new_context()
    fa, fb = fail_join(fctx_a), fail_join(fctx_b)
    f_paired = poll(lambda: 'Secure channel established' in feed_text(fa)
                    and 'Secure channel established' in feed_text(fb), 150)
    check('failure: two contexts in one code room reach a secure channel', bool(f_paired),
          f'A: {feed_text(fa)[-120:]!r} B: {feed_text(fb)[-120:]!r}')
    healthy = poll(lambda: 'connected' in peer_states(fa), 60) if f_paired else None
    check('failure: a real handshake puts the peer row on connected', bool(healthy), str(peer_states(fa)))

    # Negative control: the words only appear when something is actually wrong.
    pre_chip = chip_of(fa)
    check('failure: a healthy room says nothing about failure',
          'failed' not in (pre_chip[0] or '') and 'danger' not in (pre_chip[1] or '')
          and not [w for w in peer_states(fa) if w in ('reconnecting', 'lost', 'unreachable')],
          f'chip={pre_chip} rows={peer_states(fa)}')

    fctx_c = browser.new_context()
    fctx_c.add_init_script(RELAY_ONLY)
    fc = fail_join(fctx_c)
    got = poll(lambda: 'failed' in (chip_of(fa)[0] or ''), 120)
    check('failure: a connection that cannot be built is counted on the chip instead of hiding it',
          bool(got), f'chip={chip_of(fa)} sys={sys_lines(fa)[-2:]}')
    chip_now = chip_of(fa)
    check('failure: the chip keeps counting the working connection beside the failed one',
          'connected' in (chip_now[0] or '') and 'failed' in (chip_now[0] or ''), str(chip_now))
    check('failure: the chip carries the danger class while a connection is failed',
          'danger' in (chip_now[1] or ''), str(chip_now))
    said = [l for l in sys_lines(fa) if l.startswith('Could not connect to')]
    check('failure: the feed says a connection could not be made', bool(said), str(sys_lines(fa)[-3:]))
    # One clause, and only the cause the code can establish: TURN_SERVERS is empty.
    check('failure: the report names the missing relay and nothing it cannot know',
          bool(said) and 'No relay server is configured' in said[0]
          and 'symmetric or carrier-grade NAT' in said[0], str(said[:1]))
    check('failure: the same failure is reported once however often it is retried',
          len(said) == 1, str(said))
    check('failure: a failure elsewhere does not repaint a working connection',
          'connected' in peer_states(fa), str(peer_states(fa)))
    check('failure: the peer that could not connect reports it on its own side too',
          bool(poll(lambda: [l for l in sys_lines(fc) if l.startswith('Could not connect to')], 90)),
          str(sys_lines(fc)[-3:]))
    fctx_a.close()
    fctx_b.close()
    fctx_c.close()

    # ============ sound the autoplay policy held back ============
    # Someone who opened an invite link and never clicked has no activation, and Chromium
    # refuses autoplay with sound for them, so the remote <video> stayed on a black first
    # frame for that one viewer. Headless Chromium does not apply the policy on its own,
    # so this browser is launched with the policy desktop Chrome runs with.
    #
    # Every Playwright query into a page (evaluate, locators, wait_for_selector) runs as a
    # user gesture and would hand the viewer the activation under test, so the viewer is
    # never queried until the click that is meant to activate it. An init script reports
    # its state on the console instead, and the waits run on the main page.
    ap_browser = p.chromium.launch(headless=True, args=[
        '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
        '--autoplay-policy=user-gesture-required'])
    AP_CODE = 'a' + os.urandom(3).hex()
    AP_REPORT = """
      setInterval(() => {
        const v = document.querySelector('.tiles video.tile')
        const feed = document.querySelector('.feed')
        console.log('AP ' + JSON.stringify({
          paired: !!feed && feed.textContent.includes('Secure channel established'),
          active: navigator.userActivation.hasBeenActive,
          vid: v ? { paused: v.paused, muted: v.muted, t: v.currentTime } : null,
          notice: !!document.querySelector('.stage-tile .tile-sound'),
          card: [...document.querySelectorAll('.feed button')].some(b => b.textContent === 'Turn sound on'),
        }))
      }, 250)
    """
    ap_state = {}

    def ap_seen(m):
        if m.text.startswith('AP '):
            ap_state.clear()
            ap_state.update(json.loads(m.text[3:]))

    actx_a = ap_browser.new_context(permissions=['microphone', 'camera'])
    actx_b = ap_browser.new_context()
    actx_b.add_init_script(AP_REPORT)
    ap_a, ap_b = actx_a.new_page(), actx_b.new_page()
    ap_b.on('console', ap_seen)
    ap_a.goto(f'{BASE}/#/join/{AP_CODE}')
    ap_a.wait_for_selector('.composer', timeout=30000)
    ap_b.goto(f'{BASE}/#/join/{AP_CODE}')
    ap_paired = poll(lambda: 'Secure channel established' in ap_a.locator('.feed').inner_text()
                     and ap_state.get('paired'), 150)
    check('the autoplay contexts reach a secure channel', bool(ap_paired), str(ap_state))
    if ap_paired:
        poll(lambda: 'connected' in (ap_a.locator('.topbar .badge').inner_text() or ''), 60)
        ap_a.locator('.composer .bar button[title^="Share your camera"]').click()
        ap_got = poll(lambda: ap_state.get('vid'), 90)
        check('a camera with sound reaches a viewer who never interacted', bool(ap_got), str(ap_state))
        check('that viewer has no activation, so the policy applies to it',
              ap_state.get('active') is False, str(ap_state))
        ap_playing = poll(lambda: (ap_state.get('vid') or {}).get('t', 0) > 0
                          and not ap_state['vid']['paused'], 20)
        check('the video plays rather than holding a black first frame', bool(ap_playing), str(ap_state))
        check('it plays muted until the viewer interacts',
              bool(ap_playing) and ap_state['vid']['muted'], str(ap_state))
        check('the tile and the feed both say the browser held its sound back',
              bool(poll(lambda: ap_state.get('notice') and ap_state.get('card'), 5)), str(ap_state))
        if ap_state.get('notice'):
            ap_b.locator('.stage-tile .tile-sound').click()
        ap_back = poll(lambda: (ap_state.get('vid') or {}).get('muted') is False
                       and not ap_state['vid']['paused'], 10)
        check('the first click gives the sound back', bool(ap_back), str(ap_state))
        check('and takes both notices away',
              bool(poll(lambda: not ap_state.get('notice') and not ap_state.get('card'), 5)), str(ap_state))
    actx_a.close()
    actx_b.close()
    ap_browser.close()

    # ============ two live sources reach a peer that joins late ============
    # Trystero pairs stream metadata with ontrack events first in first out, and ontrack
    # fires per track. A peer joining while camera (audio + video) and screen were both
    # live received both offers at once: the camera's second track took the screen's label,
    # so the camera was shown twice and the screen never arrived.
    TWO_CODE = 'm' + os.urandom(3).hex()
    tctx_a = browser.new_context(permissions=['microphone', 'camera'])
    tctx_a.add_init_script(FAKE_SCREEN)
    two_a = tctx_a.new_page()
    two_errs = []
    two_a.on('console', lambda m: two_errs.append(m.text) if m.type == 'error' else None)
    two_a.on('pageerror', lambda e: two_errs.append(str(e)))
    two_a.goto(f'{BASE}/#/join/{TWO_CODE}')
    two_a.wait_for_selector('.composer', timeout=30000)
    two_a.locator('.composer .bar button[title^="Share your camera"]').click()
    two_a.locator('.composer .bar button[title^="Share your screen"]').click()
    check('the late-join sender has camera and screen live before anyone joins',
          bool(poll(lambda: two_a.locator('.tiles .stage-tile').count() == 2, 15)),
          '%d tiles' % two_a.locator('.tiles .stage-tile').count())
    tctx_b = browser.new_context()
    two_b = tctx_b.new_page()
    two_b.goto(f'{BASE}/#/join/{TWO_CODE}')
    two_b.wait_for_selector('.composer', timeout=30000)
    TWO_TILES = ("() => [...document.querySelectorAll('.tiles .stage-tile')].map(t => ({"
                 " kind: [...t.classList].find(c => c.startsWith('kind-')),"
                 " stream: t.querySelector('video').srcObject && t.querySelector('video').srcObject.id,"
                 " video: t.querySelector('video').srcObject ? t.querySelector('video').srcObject.getVideoTracks().length : 0 }))")
    two_got = poll(lambda: len(two_b.evaluate(TWO_TILES)) >= 2, 120)
    two_b.wait_for_timeout(1500)  # let any duplicate report land before counting
    two = two_b.evaluate(TWO_TILES)
    check('a late joiner receives both live sources', bool(two_got), str(two))
    check('as exactly one camera tile and one screen tile',
          sorted(t['kind'] for t in two) == ['kind-cam', 'kind-screen'], str(two))
    check('carried by two different streams', len({t['stream'] for t in two}) == 2, str(two))
    # Both contexts are behind one public IP, so they also meet in the nearby room. The
    # sender belongs under the code room the two of them joined, which otherwise read
    # "Waiting for someone with the code" beside a Nearby group listing that same device.
    GROUPS = "() => [...document.querySelectorAll('.peers details.pgroup > summary')].map(s => s.textContent)"
    two_groups = two_b.evaluate(GROUPS)
    check('a device sharing the code is listed in the code room, not under Nearby',
          any(g.startswith('Code ') and g.endswith('(1)') for g in two_groups)
          and 'Waiting for someone with the code' not in two_b.locator('.peers').inner_text(), str(two_groups))
    check('the sender logged no track or negotiation error',
          not [e for e in two_errs if 'addTrack' in e or 'sender already exists' in e or 'negotiat' in e.lower()],
          ' | '.join(two_errs)[:200])
    tctx_a.close()
    tctx_b.close()

    # ============ transfer, handshake and ratchet: regressions ============
    # Settings' nearby toggle dispatches this. Off, so a code room is the only path between
    # the contexts of a block and nothing reaches the other pages of this run.
    NEARBY_OFF = "() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))"

    def downloaded_sha(pg, name):
        """SHA-256 of what the file card's Download link saves, or None before it exists.
        Clicked for real: the page CSP blocks fetch() on blob URLs, and the saved file is
        what a person ends up with anyway."""
        link = pg.locator(f'.feed a[download="{name}"]')
        if not link.count():
            return None
        with pg.expect_download() as dl:
            link.last.click()
        return hashlib.sha256(io.open(dl.value.path(), 'rb').read()).hexdigest()

    # Per-sender chunk gate: a chunk counts only from the peer that offered its file, since
    # every recipient of a broadcast holds the same fileId and key. One sender and two
    # recipients in one code room; both downloads must hash to the bytes attached, so the
    # gate keeps co-recipients from blocking each other. A co-recipient forging chunks needs
    # a modified client and is not staged.
    CR_CODE = 'x' + os.urandom(3).hex()
    cr_name = f'wt-cr-{CR_CODE}.bin'
    cr_bytes = os.urandom(500 * 1024)
    io.open(os.path.join(SNAP, cr_name), 'wb').write(cr_bytes)
    cr_sha = hashlib.sha256(cr_bytes).hexdigest()
    cr_ctxs = [browser.new_context() for _ in range(3)]
    cr_pages = []
    for _c in cr_ctxs:
        _c.add_init_script(VISIBILITY)
        _pg = _c.new_page()
        _pg.goto(f'{BASE}/#/join/{CR_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
        cr_pages.append(_pg)
    cr_s, cr_r1, cr_r2 = cr_pages
    cr_paired = poll(lambda: cr_s.locator('.peer .peer-state').all_inner_texts() == ['connected', 'connected'], 150)
    check('one sender reaches two recipients in a code room', bool(cr_paired),
          str(cr_s.locator('.peer .peer-state').all_inner_texts()))
    if cr_paired:
        cr_s.locator('.composer-wrap > input[type=file]:not([accept])').set_input_files(os.path.join(SNAP, cr_name))
        cr_s.wait_for_selector(f'.card:has-text("{cr_name}") button:has-text("Send to devices")', timeout=20000)
        cr_s.locator('.card', has_text=cr_name).locator('button', has_text='Send to devices').click()
        poll(lambda: all(_pg.locator(f'.feed a[download="{cr_name}"]').count() > 0 for _pg in (cr_r1, cr_r2)), 90)
        cr_got = [downloaded_sha(_pg, cr_name) for _pg in (cr_r1, cr_r2)]
        check('both recipients of a broadcast file get it byte-exact', cr_got == [cr_sha, cr_sha],
              f'got={[g and g[:12] for g in cr_got]} want={cr_sha[:12]}')
    for _c in cr_ctxs:
        _c.close()

    # Handshake reservation: onPeerJoin and the first inbound hs share one PeerState and send
    # one hs. Two contexts in one code room, nearby off so the code tier is the only path
    # between them, must reach exactly one secure channel each with one connected roster row.
    # A duplicate PeerState would print a second channel card or leave a peer stuck at '...'.
    HS_CODE = 'x' + os.urandom(3).hex()
    hctx_a = browser.new_context()
    hctx_a.add_init_script(VISIBILITY)
    hctx_b = browser.new_context()
    hctx_b.add_init_script(VISIBILITY)
    hs_a, hs_b = hctx_a.new_page(), hctx_b.new_page()
    for _pg in (hs_a, hs_b):
        _pg.goto(f'{BASE}/#/join/{HS_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
    hs_paired = poll(lambda: 'Secure channel established' in feed_text(hs_a)
                     and 'Secure channel established' in feed_text(hs_b), 150)
    check('two contexts in a code room reach a secure channel', bool(hs_paired),
          f'A: {feed_text(hs_a)[-120:]!r} B: {feed_text(hs_b)[-120:]!r}')
    if hs_paired:
        # Exactly one card per side: the join race would have created a second PeerState and
        # sent a second hs, doubling this.
        na = feed_text(hs_a).count('Secure channel established')
        nb = feed_text(hs_b).count('Secure channel established')
        check('one peer yields one secure-channel card, not two', na == 1 and nb == 1, f'A={na} B={nb}')
        # The roster settles to one connected peer each. A stuck handshake leaves it at
        # 'connecting' instead.
        settled = poll(lambda: hs_a.locator('.peer .peer-state').all_inner_texts() == ['connected']
                       and hs_b.locator('.peer .peer-state').all_inner_texts() == ['connected'], 30)
        check('each side shows exactly one connected peer, none stuck connecting', bool(settled),
              f"A={hs_a.locator('.peer .peer-state').all_inner_texts()} B={hs_b.locator('.peer .peer-state').all_inner_texts()}")
    hctx_a.close()
    hctx_b.close()

    # Outgoing repair window: the send pass holds the file as `sending` and opens the TTL
    # only after the fend. A plain attachment (the attach input, so no OCR) goes from A to
    # B, and the bytes behind B's Download link must hash to what A attached. A transfer
    # longer than the TTL with a lost chunk is not staged here.
    TTL_CODE = 'x' + os.urandom(3).hex()
    ttl_name = f'wt-ttl-{TTL_CODE}.bin'
    ttl_path = os.path.join(SNAP, ttl_name)
    ttl_bytes = os.urandom(700 * 1024)  # 11 chunks of 64 KiB
    io.open(ttl_path, 'wb').write(ttl_bytes)
    ttl_sha = hashlib.sha256(ttl_bytes).hexdigest()

    tctx_s = browser.new_context()
    tctx_s.add_init_script(VISIBILITY)
    tctx_r = browser.new_context()
    tctx_r.add_init_script(VISIBILITY)
    ttl_s, ttl_r = tctx_s.new_page(), tctx_r.new_page()
    for _pg in (ttl_s, ttl_r):
        _pg.goto(f'{BASE}/#/join/{TTL_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
    ttl_paired = poll(lambda: 'Secure channel established' in feed_text(ttl_s)
                      and 'Secure channel established' in feed_text(ttl_r)
                      and 'connected' in (ttl_s.locator('.topbar .badge').inner_text() or ''), 150)
    check('sender and receiver pair for the attachment transfer', bool(ttl_paired),
          f'S: {feed_text(ttl_s)[-120:]!r} R: {feed_text(ttl_r)[-120:]!r}')
    if ttl_paired:
        ttl_s.locator('.composer-wrap > input[type=file]:not([accept])').set_input_files(ttl_path)
        ttl_s.wait_for_selector('.card button:has-text("Send to devices")', timeout=20000)
        ttl_s.locator('.card button', has_text='Send to devices').last.click()
        poll(lambda: ttl_r.locator(f'.feed a[download="{ttl_name}"]').count() > 0, 90)
        got = downloaded_sha(ttl_r, ttl_name)
        check('an attached file arrives and its download hashes to the bytes that were sent',
              got == ttl_sha, f'got={got!r} want={ttl_sha[:12]} R: {feed_text(ttl_r)[-160:]!r}')
        check('the attachment finished without a repair failure',
              'did not finish' not in feed_text(ttl_r) and 'Failed to decrypt' not in feed_text(ttl_r),
              feed_text(ttl_r)[-160:])
    tctx_s.close()
    tctx_r.close()

    # Pending chunk buffers: chunks that outrun their offer wait in a per-sender buffer that
    # is now timed and closed once its file finishes. Two attachments sent back to back put
    # both offers and their early chunks in flight together, and both downloads must hash
    # to the bytes attached. A refused or unopenable offer, the case the purge bounds,
    # needs a tampered peer and is not staged.
    PEND_CODE = 'x' + os.urandom(3).hex()
    pend_files = []
    for _n in (1, 2):
        _name = f'wt-pend{_n}-{PEND_CODE}.bin'
        _bytes = os.urandom(300 * 1024 * _n)
        io.open(os.path.join(SNAP, _name), 'wb').write(_bytes)
        pend_files.append((_name, hashlib.sha256(_bytes).hexdigest()))
    pctx_s = browser.new_context()
    pctx_s.add_init_script(VISIBILITY)
    pctx_r = browser.new_context()
    pctx_r.add_init_script(VISIBILITY)
    pend_s, pend_r = pctx_s.new_page(), pctx_r.new_page()
    for _pg in (pend_s, pend_r):
        _pg.goto(f'{BASE}/#/join/{PEND_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
    pend_paired = poll(lambda: 'Secure channel established' in feed_text(pend_s)
                       and 'Secure channel established' in feed_text(pend_r)
                       and 'connected' in (pend_s.locator('.topbar .badge').inner_text() or ''), 150)
    check('sender and receiver pair for the back-to-back transfer', bool(pend_paired),
          f'S: {feed_text(pend_s)[-120:]!r} R: {feed_text(pend_r)[-120:]!r}')
    if pend_paired:
        for _name, _ in pend_files:
            pend_s.locator('.composer-wrap > input[type=file]:not([accept])').set_input_files(os.path.join(SNAP, _name))
            pend_s.wait_for_selector(f'.card:has-text("{_name}") button:has-text("Send to devices")', timeout=20000)
        # Both presses in one task, so the two sends overlap on the wire.
        pend_s.evaluate("() => [...document.querySelectorAll('.card button')].filter(b => b.textContent.trim() === 'Send to devices').slice(-2).forEach(b => b.click())")
        poll(lambda: all(pend_r.locator(f'.feed a[download="{n}"]').count() > 0 for n, _ in pend_files), 90)
        got = [downloaded_sha(pend_r, n) for n, _ in pend_files]
        check('two attachments sent together both arrive byte-exact',
              got == [h for _, h in pend_files],
              f'got={[g and g[:12] for g in got]} R: {feed_text(pend_r)[-160:]!r}')
    pctx_s.close()
    pctx_r.close()

    # Rejoin during a leave: Trystero returns the same room object for a roomId until its
    # leave has finished (a leave frame, then 99 ms), so turning the online list off and on
    # in one go used to attach the new session to a room that then destroyed its peers and
    # stopped announcing. Both devices must see each other again afterwards. Nearby is off
    # on both, since a device reachable there is listed under Nearby instead of Online now.
    PRESENCE_ROW = ("n => { const g = [...document.querySelectorAll('details.pgroup')]"
                    ".find(d => (d.querySelector('summary')?.textContent || '').startsWith('Online now'));"
                    " const r = g && [...g.querySelectorAll('.peer')].find(x => (x.querySelector('.claimed')?.textContent || '').trim() === n);"
                    " return r ? r.querySelector('.peer-state').textContent : null }")
    rctx_a = browser.new_context()
    rctx_a.add_init_script(VISIBILITY)
    rctx_b = browser.new_context()
    rctx_b.add_init_script(VISIBILITY)
    rj_a, rj_b = rctx_a.new_page(), rctx_b.new_page()
    for _pg in (rj_a, rj_b):
        _pg.goto(f'{BASE}/')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
        _pg.locator('.topbar button.roster-toggle').click()  # the sidebar, and its switch, start collapsed
        presence_box(_pg).check()
    name_a = rj_a.locator('input[aria-label="This device name"]').first.input_value()
    name_b = rj_b.locator('input[aria-label="This device name"]').first.input_value()
    rj_met = poll(lambda: rj_a.evaluate(PRESENCE_ROW, name_b) == 'visible'
                  and rj_b.evaluate(PRESENCE_ROW, name_a) == 'visible', 150)
    check('two devices on the online list see each other', bool(rj_met),
          f'A sees {rj_a.evaluate(PRESENCE_ROW, name_b)!r}, B sees {rj_b.evaluate(PRESENCE_ROW, name_a)!r}')
    if rj_met:
        # Off and on in one task: two real clicks on the switch, well inside the leave.
        presence_box(rj_a).evaluate('el => { el.click(); el.click() }')
        check('the online-list switch is back on after the flip', presence_box(rj_a).is_checked())
        rj_back = poll(lambda: rj_a.evaluate(PRESENCE_ROW, name_b) == 'visible'
                       and rj_b.evaluate(PRESENCE_ROW, name_a) == 'visible', 60)
        check('after an off-and-on flip both devices list each other again, none stuck connecting', bool(rj_back),
              f'A sees {rj_a.evaluate(PRESENCE_ROW, name_b)!r}, B sees {rj_b.evaluate(PRESENCE_ROW, name_a)!r}')
    rctx_a.close()
    rctx_b.close()

    # Ratchet receive path: open() now keeps keys for skipped counters and opens a late
    # message with them. Two renames typed back to back on B are two sealed messages on the
    # ratchet, and A's roster must end on the second name with nothing failing to decrypt.
    # A large sealed message overtaken by a later one needs a big chat or a tampered peer
    # and is not staged; the reorder itself is covered outside the browser.
    RN_CODE = 'x' + os.urandom(3).hex()
    rn_first, rn_second = f'first-{RN_CODE}', f'second-{RN_CODE}'
    ROSTER_NAMES = "() => [...document.querySelectorAll('details.pgroup .peer .name')].map(x => x.textContent.trim())"
    nctx_a = browser.new_context()
    nctx_a.add_init_script(VISIBILITY)
    nctx_b = browser.new_context()
    nctx_b.add_init_script(VISIBILITY)
    rn_a, rn_b = nctx_a.new_page(), nctx_b.new_page()
    for _pg in (rn_a, rn_b):
        _pg.goto(f'{BASE}/#/join/{RN_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate(NEARBY_OFF)
    rn_paired = poll(lambda: 'Secure channel established' in feed_text(rn_a)
                     and 'Secure channel established' in feed_text(rn_b), 150)
    check('two contexts pair for the rename check', bool(rn_paired),
          f'A: {feed_text(rn_a)[-120:]!r} B: {feed_text(rn_b)[-120:]!r}')
    if rn_paired:
        rn_b.locator('.topbar button.roster-toggle').click()
        rn_field = rn_b.locator('input[aria-label="This device name"]').first
        for _name in (rn_first, rn_second):
            rn_field.fill(_name)
            rn_field.press('Enter')
        rn_seen = poll(lambda: rn_second in rn_a.evaluate(ROSTER_NAMES), 30)
        check('two renames in a row reach the peer, ending on the second name', bool(rn_seen),
              f'A roster: {rn_a.evaluate(ROSTER_NAMES)}')
        check('no sealed message failed to open on the way', 'Failed to decrypt' not in feed_text(rn_a),
              feed_text(rn_a)[-160:])
    nctx_a.close()
    nctx_b.close()

    # One identity per device from the first boot: the personal and code tiers create the
    # identity in parallel on a fresh install, and two creations stored two keypairs, so the
    # one a code-room peer met could be replaced by the other after a reload. B reads A's
    # safety number from the Verify dialog, A reloads, and B must read the same number.
    ID_CODE = 'x' + os.urandom(3).hex()
    ictx_a = browser.new_context()
    ictx_a.add_init_script(VISIBILITY)
    ictx_b = browser.new_context()
    ictx_b.add_init_script(VISIBILITY)
    id_a, id_b = ictx_a.new_page(), ictx_b.new_page()
    id_b.goto(f'{BASE}/#/join/{ID_CODE}')
    id_b.wait_for_selector('.composer', timeout=30000)
    id_b.evaluate(NEARBY_OFF)
    id_b.locator('.topbar button.roster-toggle').click()
    id_a.goto(f'{BASE}/#/join/{ID_CODE}')  # a fresh install: nothing in IndexedDB yet
    id_a.wait_for_selector('.composer', timeout=30000)
    id_a.evaluate(NEARBY_OFF)

    def safety_seen_by_b():
        """The safety number B's Verify dialog shows for its one peer, dismissed unanswered."""
        btn = id_b.locator('.peer button[title^="Verify "]')
        if btn.count() != 1:
            return None
        seen = []
        id_b.once('dialog', lambda d: (seen.append(d.message), d.dismiss()))
        btn.click()
        m = re.search(r'Safety number with .*?:\s+(.+?)\s+Compare', seen[0], re.S) if seen else None
        return m.group(1).strip() if m else None

    id_first = poll(safety_seen_by_b, 150)
    check('a peer can read the safety number of a freshly installed device', bool(id_first), feed_text(id_b)[-120:])
    if id_first:
        # The reload closes A's page, so B drops that peer before meeting the reloaded one.
        id_a.reload()
        id_a.wait_for_selector('.composer', timeout=30000)
        id_a.evaluate(NEARBY_OFF)
        id_again = poll(lambda: (id_b.locator('.peer button[title^="Verify "]').count() == 1
                                 and 'left' in feed_text(id_b) and safety_seen_by_b()), 150)
        check('the device keeps the same safety number across its first reload', id_again == id_first,
              f'before={id_first!r} after={id_again!r}')
    ictx_a.close()
    ictx_b.close()

    # ============ screen sharing is one press, from the topbar or the composer ============
    # Both controls go straight to the browser's picker and publish what it returns. The
    # topbar button doubles as the stop control while a screen is live.
    sctx = browser.new_context()
    sctx.add_init_script(FAKE_SCREEN)
    spg = sctx.new_page()
    serrs = []
    spg.on('pageerror', lambda e: serrs.append(str(e)))
    spg.goto(BASE)
    spg.wait_for_selector('.composer', timeout=30000)
    TOP_SCREEN = spg.locator('.topbar button.screen-share')
    check('the topbar offers screen sharing by name',
          TOP_SCREEN.count() == 1 and TOP_SCREEN.inner_text() == 'Share screen',
          '%d buttons' % TOP_SCREEN.count())
    check('a fresh profile has Share screen on the bar and no Studio pin',
          spg.eval_on_selector_all('.topbar button.tool-pin', 'els => els.map(e => e.dataset.tool)') == ['screen', 'connect'])
    TOP_SCREEN.click()
    check('one press on it shares the screen',
          bool(poll(lambda: spg.locator('.tiles .stage-tile.kind-screen').count() == 1, 10)),
          '%d screen tiles' % spg.locator('.tiles .stage-tile.kind-screen').count())
    check('the same button then stops it',
          TOP_SCREEN.inner_text() == 'Stop sharing' and TOP_SCREEN.get_attribute('aria-pressed') == 'true',
          '%r pressed=%r' % (TOP_SCREEN.inner_text(), TOP_SCREEN.get_attribute('aria-pressed')))
    check('sharing opens no note over the composer',
          spg.locator('.composer-wrap details.note').count() == 0)
    TOP_SCREEN.click()
    check('pressing it again stops the share',
          bool(poll(lambda: spg.locator('.tiles .stage-tile').count() == 0, 10))
          and TOP_SCREEN.inner_text() == 'Share screen',
          '%d tiles, %r' % (spg.locator('.tiles .stage-tile').count(), TOP_SCREEN.inner_text()))
    spg.locator('.composer .bar button[title^="Share your screen"]').click()
    check('the composer screen control shares in one press too',
          bool(poll(lambda: spg.locator('.tiles .stage-tile.kind-screen').count() == 1, 10))
          and TOP_SCREEN.inner_text() == 'Stop sharing')
    spg.locator('.composer .bar button[title*="Stop sharing"]').click()
    poll(lambda: spg.locator('.tiles .stage-tile').count() == 0, 10)
    check('no page error on the screen share path', not serrs, ' | '.join(serrs)[:200])
    sctx.close()

    # ============ the Studio screen note follows the browser, not the app ============
    # Whether the picker offers tab audio is the browser's call. The Studio panel explains
    # it, derived from getSupportedConstraints().suppressLocalAudioPlayback, the Screen
    # Capture constraint that exists only where display audio is implemented. Headless
    # Chromium reports it, so both branches are driven by replacing what it reports.
    def constraint_report(audio):
        return """
          const orig = navigator.mediaDevices.getSupportedConstraints.bind(navigator.mediaDevices)
          navigator.mediaDevices.getSupportedConstraints = () => {
            const c = orig()
            %s
            return c
          }
        """ % ('c.suppressLocalAudioPlayback = true' if audio
               else 'delete c.suppressLocalAudioPlayback')

    _studio_id = tool_id_for('studio')

    def note_ctx(audio):
        ctx = browser.new_context()
        ctx.add_init_script(constraint_report(audio))
        pg = ctx.new_page()
        pg.goto(BASE)
        pg.wait_for_selector('.composer', timeout=30000)
        pg.evaluate("location.hash = '#/t/%s'" % _studio_id)
        pg.wait_for_selector('details.card[data-tool="%s"] details.note' % _studio_id, timeout=15000)
        return ctx, pg

    REPORTS = '() => !!navigator.mediaDevices.getSupportedConstraints().suppressLocalAudioPlayback'
    nctx_on, npg_on = note_ctx(True)
    nctx_off, npg_off = note_ctx(False)
    check('the two contexts really report different display-audio support',
          npg_on.evaluate(REPORTS) and not npg_off.evaluate(REPORTS),
          'on=%s off=%s' % (npg_on.evaluate(REPORTS), npg_off.evaluate(REPORTS)))

    NOTE = 'details.card[data-tool="%s"] details.note' % _studio_id
    BODY = NOTE + ' .note-body'

    # Read through a presence check rather than straight off the locator: a regression that
    # drops the note has to report these as failures, not time out and abort every section
    # after this one.
    def text_of(pg, sel):
        return pg.locator(sel).inner_text() if pg.locator(sel).count() else ''

    sum_on = text_of(npg_on, NOTE + ' > summary')
    sum_off = text_of(npg_off, NOTE + ' > summary')
    check('the note reports audio capture where the browser reports the constraint',
          'can capture audio' in sum_on, repr(sum_on))
    check('the note reports none where the browser does not report it',
          'no audio capture' in sum_off, repr(sum_off))
    check('the note is a capability read rather than one fixed string', sum_on != sum_off,
          '%r == %r' % (sum_on, sum_off))
    check('the note shows one line until the detail is asked for',
          npg_on.locator(BODY).count() == 1 and not npg_on.locator(BODY).is_visible(),
          '%d bodies' % npg_on.locator(BODY).count())
    for _pg in (npg_on, npg_off):
        if _pg.locator(NOTE + ' > summary').count():
            _pg.locator(NOTE + ' > summary').click()
            _pg.wait_for_timeout(200)
    check('opening the note reveals the detail',
          npg_on.locator(BODY).count() == 1 and npg_on.locator(BODY).is_visible())
    det_on = text_of(npg_on, BODY)
    det_off = text_of(npg_off, BODY)
    check('the detail hands the picker, its audio box and the prompt to the browser',
          'belong to the browser' in det_on and 'Nothing in this app changes' in det_on,
          repr(det_on[:180]))
    check('the detail says the per-surface audio box is only known inside the picker',
          'decided inside the picker' in det_on and 'decided inside the picker' not in det_off,
          repr(det_on))
    check('the detail states what each browser supports without ranking them',
          'Firefox and LibreWolf capture picture only' in det_off, repr(det_off[-160:]))
    nctx_on.close()
    nctx_off.close()

    # ============ stage, tiers and feed: regressions ============

    def nearby_group(pg):
        return pg.evaluate("() => [...document.querySelectorAll('.sidebar .pgroup > summary')]"
                           ".some(s => s.textContent.startsWith('Nearby'))")

    def nearby_off(pg):
        """Leave the nearby tier, which every headless context in this run shares, so a
        message typed here reaches only this block's own room. Waits for the tier to open
        first: the boot pass reads the stored switch after an await and would turn a
        switch flipped earlier back on."""
        poll(lambda: nearby_group(pg), 30)
        pg.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
        return bool(poll(lambda: not nearby_group(pg), 15))

    CODE_PEERS = ("() => { const g = [...document.querySelectorAll('.sidebar .pgroup')]"
                  ".find(x => x.querySelector('summary').textContent.startsWith('Code '));"
                  " return g ? g.querySelectorAll('.peer').length : 0 }")

    # --- a share the browser ends is unpublished ---
    # Chrome's "Stop sharing" bar ends the track without touching any control on the page.
    # The page is told the way the browser tells it: the track stops and fires `ended`,
    # which track.stop() alone never does. A dead source left published stayed tiled,
    # expanded and guarded, and was re-offered to every later peer as a black tile.
    BROWSER_STOP = """() => {
      for (const v of document.querySelectorAll('.stage-tile.kind-screen video')) {
        for (const t of v.srcObject.getTracks()) { t.stop(); t.dispatchEvent(new Event('ended')) }
      }
    }"""
    END_CODE = 'x' + os.urandom(3).hex()
    ectx_a = browser.new_context()
    ectx_a.add_init_script(FAKE_SCREEN)
    en_a = ectx_a.new_page()
    en_a.goto(f'{BASE}/#/join/{END_CODE}')
    en_a.wait_for_selector('.composer', timeout=30000)
    en_share = en_a.locator('.composer .bar button[title^="Share your screen"]')
    en_share.click()
    en_live = poll(lambda: en_a.locator('.tiles .stage-tile.kind-screen').count() == 1, 15)
    check('a screen share is live before the browser ends it',
          bool(en_live) and theater(en_a) and en_a.evaluate("document.documentElement.dataset.closeGuard") == 'on',
          'tiles=%d max=%s' % (en_a.locator('.tiles .stage-tile').count(), theater(en_a)))
    en_a.evaluate(BROWSER_STOP)
    check('a share the browser ends leaves the stage',
          bool(poll(lambda: en_a.locator('.tiles .stage-tile').count() == 0, 10)),
          '%d tiles' % en_a.locator('.tiles .stage-tile').count())
    check('the stage it expanded shrinks back', not theater(en_a))
    check('closing the tab no longer asks once nothing is live',
          en_a.evaluate("document.documentElement.dataset.closeGuard") == 'off')
    en_top = en_a.locator('.topbar button.screen-share')
    check('the topbar offers to share again',
          en_top.count() == 0 or en_top.inner_text() == 'Share screen',
          en_top.inner_text() if en_top.count() else '')
    # A peer joining after a second share must be offered only the live one. With the dead
    # stream still published it arrived first, as a black tile that took the spotlight.
    en_share.click()
    poll(lambda: en_a.locator('.tiles .stage-tile.kind-screen').count() == 1, 15)
    ectx_b = browser.new_context()
    en_b = ectx_b.new_page()
    en_b.goto(f'{BASE}/#/join/{END_CODE}')
    en_b.wait_for_selector('.composer', timeout=30000)
    en_got = poll(lambda: en_b.locator('.tiles .stage-tile').count() >= 1, 150)
    check('a late joiner receives the live share', bool(en_got), en_b.locator('.feed').inner_text()[-160:])
    check('and no tile for the share the browser ended',
          bool(en_got) and not poll(lambda: en_b.locator('.tiles .stage-tile').count() >= 2, 5),
          '%d tiles' % en_b.locator('.tiles .stage-tile').count())
    check('the spotlight lands on a tile that is playing',
          bool(en_got) and bool(poll(lambda: en_b.evaluate(
              "() => { const v = document.querySelector('.stage-tile.spot video'); return !!v && v.currentTime > 0 }"), 20)))
    ectx_a.close()
    ectx_b.close()

    # --- a remote source is named after its sender ---
    # The sender's label is self-asserted and read "Your screen" on every viewer's stage, so
    # a stranger's feed was presented as the viewer's own. The viewer names it from its own
    # roster instead, and keeps the name current.
    LBL_CODE = 'x' + os.urandom(3).hex()
    lctx_a = browser.new_context()
    lctx_a.add_init_script(FAKE_SCREEN)
    lctx_b = browser.new_context()
    lb_a, lb_b = lctx_a.new_page(), lctx_b.new_page()
    for _pg in (lb_a, lb_b):
        _pg.goto(f'{BASE}/#/join/{LBL_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
    lb_name = lb_a.locator('.sidebar input[aria-label="This device name"]').input_value()
    lb_reach = poll(lambda: 'connected' in (lb_a.locator('.topbar .badge').inner_text() or ''), 150)
    check('the labelling contexts reach each other', bool(lb_reach), lb_a.locator('.feed').inner_text()[-160:])
    lb_a.locator('.composer .bar button[title^="Share your screen"]').click()
    lb_got = poll(lambda: lb_b.locator('.tiles .stage-tile .tile-name').count() >= 1, 90)
    lb_plate = lb_b.locator('.tiles .stage-tile .tile-name').first.inner_text() if lb_got else ''
    check("a viewer's nameplate names the sender, not the viewer",
          f"{lb_name}'s screen" in lb_plate and 'Your' not in lb_plate, f'{lb_plate!r} sender={lb_name!r}')
    check("the viewer's tile controls carry the same name",
          lb_b.locator(f'.stage-tile button[title="Spotlight {lb_name}\'s screen"]').count() == 1)
    lb_own = lb_a.locator('.tiles .stage-tile .tile-name').first.inner_text()
    check("the sender's own tile carries its own name, marked as its own",
          f"{lb_name}'s screen (you)" in lb_own and 'Your' not in lb_own, repr(lb_own))
    # A name can change after the tile is built. The nameplate and the control names are
    # drawn from the roster on every change, so a rename reaches a share already running.
    lb_new = 'renamed-' + os.urandom(2).hex()
    lb_field = lb_a.locator('.sidebar input[aria-label="This device name"]')
    if not lb_field.is_visible():
        lb_a.locator('.topbar button[title*="devices & people"]').click()
    lb_field.fill(lb_new)
    lb_field.press('Enter')
    lb_field.blur()
    check("a rename reaches the viewer's nameplate on a running share",
          bool(poll(lambda: f"{lb_new}'s screen" in lb_b.locator('.tiles .stage-tile .tile-name').first.inner_text(), 30)),
          repr(lb_b.locator('.tiles .stage-tile .tile-name').first.inner_text()))
    check("and the viewer's tile controls follow it",
          lb_b.locator(f'.stage-tile button[title="Spotlight {lb_new}\'s screen"]').count() == 1)
    check("and the sender's own nameplate follows it",
          f"{lb_new}'s screen (you)" in lb_a.locator('.tiles .stage-tile .tile-name').first.inner_text(),
          repr(lb_a.locator('.tiles .stage-tile .tile-name').first.inner_text()))
    lctx_a.close()
    lctx_b.close()

    # --- an ordinary reply is never taken for a join code ---
    # "10min" carries a digit, which was enough to auto-join it: the reply never reached the
    # room and the sender's camera moved to a room anyone could guess. Only the generated
    # shape auto-joins, and not while the current room has people in it.
    TOK_CODE = 'x' + os.urandom(3).hex()
    kctx_a = browser.new_context()
    kctx_b = browser.new_context()
    tk_a = kctx_a.new_page()
    tk_a.goto(f'{BASE}/#/join/{TOK_CODE}')
    tk_a.wait_for_selector('.composer', timeout=30000)
    check('the typing context leaves the shared nearby tier first', nearby_off(tk_a))
    tk_chip = lambda: tk_a.locator('button.code-chip').inner_text().strip()
    poll(lambda: tk_chip() == TOK_CODE.upper(), 20)
    tk_a.locator('.composer textarea').fill('10min')
    tk_a.locator('.composer textarea').press('Enter')
    check('a reply like 10min stays in the room it was typed in',
          not poll(lambda: tk_chip() != TOK_CODE.upper(), 3) and tk_a.locator('.sys', has_text='is a join code').count() == 0,
          tk_chip())
    check('and offers joining it as an explicit button instead',
          tk_a.locator('.msg.me button', has_text='Join code 10MIN').count() == 1)
    tk_b = kctx_b.new_page()
    tk_b.goto(f'{BASE}/#/join/{TOK_CODE}')
    tk_b.wait_for_selector('.composer', timeout=30000)
    tk_reach = poll(lambda: tk_a.evaluate(CODE_PEERS) >= 1, 150)
    check('a second device joins the typing room', bool(tk_reach), tk_a.locator('.feed').inner_text()[-160:])
    check('the queued reply reaches it', bool(poll(lambda: '10min' in tk_b.locator('.feed').inner_text(), 60)))
    tk_gen = 'k7' + ''.join(CODE_ALPHABET[b % len(CODE_ALPHABET)] for b in os.urandom(4))
    tk_a.locator('.composer textarea').fill(tk_gen)
    tk_a.locator('.composer textarea').press('Enter')
    check('a generated-shape code typed with people in the room does not switch rooms',
          not poll(lambda: tk_chip() != TOK_CODE.upper(), 3), tk_chip())
    check('it is offered as a Join button',
          tk_a.locator('.msg.me button', has_text=f'Join code {tk_gen.upper()}').count() == 1)
    check('and reaches the people in the room', bool(poll(lambda: tk_gen in tk_b.locator('.feed').inner_text(), 60)))
    kctx_a.close()
    kctx_b.close()

    # --- a stranger on the nearby tier cannot take over the stage ---
    # No stock client publishes into nearby, so the sender here is a modified client: the
    # stock page with its nearby session captured as it is stored and handed a screen
    # directly. The viewer counts the tracks its peer connections receive, which shows the
    # stream really arrives, and has to refuse to put it on the stage.
    GRAB_NEARBY = """
      const realSet = Map.prototype.set
      Map.prototype.set = function (k, v) {
        if (k === 'nearby' && v && typeof v.addMedia === 'function') window.__nearby = v
        return realSet.call(this, k, v)
      }
    """
    COUNT_TRACKS = """
      window.__tracks = 0
      const RealPC = window.RTCPeerConnection
      window.RTCPeerConnection = new Proxy(RealPC, {
        construct(target, args) {
          const pc = new target(...args)
          pc.addEventListener('track', () => { window.__tracks++ })
          return pc
        },
      })
    """
    nctx_x = browser.new_context()
    nctx_x.add_init_script(FAKE_SCREEN)
    nctx_x.add_init_script(GRAB_NEARBY)
    nctx_v = browser.new_context()
    nctx_v.add_init_script(COUNT_TRACKS)
    nb_x, nb_v = nctx_x.new_page(), nctx_v.new_page()
    for _pg in (nb_x, nb_v):
        _pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
        _pg.wait_for_selector('.composer', timeout=30000)
    nb_open = poll(lambda: nb_x.evaluate('!!window.__nearby'), 30)
    check('the sending context has a nearby session to abuse', bool(nb_open))
    if nb_open:
        nb_x.evaluate("async () => window.__nearby.addMedia(await navigator.mediaDevices.getDisplayMedia(),"
                      " { kind: 'screen', label: 'Your screen' })")
        nb_arrived = poll(lambda: nb_v.evaluate('window.__tracks') > 0, 150)
        check("a nearby stranger's stream reaches the viewer's peer connection", bool(nb_arrived))
        check('and is never put on the stage',
              bool(nb_arrived) and not poll(lambda: nb_v.locator('.tiles .stage-tile').count() > 0, 5),
              '%d tiles' % nb_v.locator('.tiles .stage-tile').count())
        check('nor expands it over the feed', not theater(nb_v))
    nctx_x.close()
    nctx_v.close()

    # --- leaving a room takes its peers' media off the stage ---
    # Leaving emits no peer-leave, so the tile of a peer reachable only through that room
    # stayed expanded on its last frame. Both contexts leave the shared nearby tier first:
    # with a second room in common, the sender's renegotiation still reaches the viewer and
    # removes the track, which hides the missing teardown.
    LV_CODE = 'x' + os.urandom(3).hex()
    vctx_a = browser.new_context()
    vctx_a.add_init_script(FAKE_SCREEN)
    vctx_b = browser.new_context()
    lv_a, lv_b = vctx_a.new_page(), vctx_b.new_page()
    for _pg in (lv_a, lv_b):
        _pg.goto(f'{BASE}/#/join/{LV_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
    check('both leaving contexts drop the shared nearby tier', nearby_off(lv_a) and nearby_off(lv_b))
    lv_reach = poll(lambda: lv_b.evaluate(CODE_PEERS) >= 1, 150)
    check('the leaving contexts share only a code room', bool(lv_reach), lv_b.locator('.feed').inner_text()[-160:])
    lv_a.locator('.composer .bar button[title^="Share your screen"]').click()
    lv_got = poll(lambda: lv_b.locator('.tiles .stage-tile.kind-screen').count() == 1, 90)
    check("the viewer's stage expands to the share", bool(lv_got) and theater(lv_b))
    lv_b.locator('.topbar button', has_text='Connect').click()
    lv_b.locator('.modal button', has_text='Stop code room').click()
    lv_b.keyboard.press('Escape')
    check('leaving the room takes its tile off the stage',
          bool(poll(lambda: lv_b.locator('.tiles .stage-tile').count() == 0, 10)),
          '%d tiles' % lv_b.locator('.tiles .stage-tile').count())
    check('and gives the window back to the feed', not theater(lv_b))
    vctx_a.close()
    vctx_b.close()

    # --- a paired device in the same code room shows each source once ---
    # A paired device is reached on both media tiers and publishes to both, and the one
    # peer connection it shares with the viewer delivers the stream to both rooms. Each
    # arrival made a tile, so a screen showed twice and a mic played twice.
    DUP_CODE = 'x' + os.urandom(3).hex()
    dctx_a = browser.new_context()
    dctx_a.add_init_script(FAKE_SCREEN)
    dctx_b = browser.new_context()
    dp_a, dp_b = dctx_a.new_page(), dctx_b.new_page()
    dp_a.goto(f'{BASE}/#/join/{DUP_CODE}')
    dp_a.wait_for_selector('.composer', timeout=30000)
    dp_a.locator('.topbar button', has_text='Connect').click()
    dp_a.wait_for_selector('.modal input[readonly]', timeout=10000)
    dp_link = dp_a.locator('.modal input[readonly]').input_value()
    dp_a.keyboard.press('Escape')
    dp_b.goto(dp_link)
    dp_b.wait_for_selector('.composer', timeout=30000)
    dp_b.goto(f'{BASE}/#/join/{DUP_CODE}')
    dp_b.wait_for_selector('.composer', timeout=30000)
    DP_MINE = ("() => { const g = [...document.querySelectorAll('.sidebar .pgroup')]"
               ".find(x => x.querySelector('summary').textContent.startsWith('My devices'));"
               " return g ? g.querySelectorAll('.peer').length : 0 }")
    dp_paired = poll(lambda: dp_b.evaluate(DP_MINE) >= 1, 150)
    check('the pair link puts the second context on My devices', bool(dp_paired),
          dp_b.locator('.sidebar').inner_text()[:200])
    check('while it also holds the shared code room', dp_b.locator('button.code-chip').inner_text().strip() == DUP_CODE.upper())
    dp_a.locator('.composer .bar button[title^="Share your screen"]').click()
    dp_got = poll(lambda: dp_b.locator('.tiles .stage-tile').count() >= 1, 90)
    check('the paired viewer receives the share', bool(dp_got))
    check('as a single tile', bool(dp_got) and not poll(lambda: dp_b.locator('.tiles .stage-tile').count() >= 2, 10),
          '%d tiles' % dp_b.locator('.tiles .stage-tile').count())
    check('with a single spotlight', dp_b.locator('.tiles .stage-tile.spot').count() == 1)
    dctx_a.close()
    dctx_b.close()

    # --- a stage expanded by hand ends with its last video ---
    # Only an expansion a screen share opened was released, and the stage-max rule keeps
    # the tiles region displayed, so stopping the last source left an expanded stage holding
    # nothing but its head, with the feed hidden behind it.
    xctx = browser.new_context()
    xp = xctx.new_page()
    xp.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    xp.wait_for_selector('.composer', timeout=30000)
    xp.locator('.composer .bar button[title^="Share your camera"]').click()
    x_cam = poll(lambda: xp.locator('.tiles .stage-tile.kind-cam').count() == 1, 15)
    check('a camera share does not expand the stage on its own', bool(x_cam) and not theater(xp))
    xp.locator('.tiles-head button[title*="Expand the stage"]').click()
    check('the expand control expands it', theater(xp))
    xp.locator('.stage-tile.kind-cam button[title^="Stop sharing "]').click()
    check('stopping the last video releases a hand-made expansion',
          bool(poll(lambda: not theater(xp), 5)), '%d tiles' % xp.locator('.tiles .stage-tile').count())
    check('and the empty stage goes with it', not xp.locator('.tiles-region').is_visible())
    xctx.close()

    # --- accepting an invite does not carry live media into the inviter's room ---
    # The prompt promised the camera, mic and screen stay off, yet joining the inviter's
    # room republished every live source into it. Both contexts leave nearby first: a peer
    # also reached there is listed under Nearby, where there is nothing to invite.
    IV_A, IV_B = 'x' + os.urandom(3).hex(), 'x' + os.urandom(3).hex()
    ictx_a = browser.new_context()
    ictx_b = browser.new_context()
    iv_a, iv_b = ictx_a.new_page(), ictx_b.new_page()
    for _pg, _code in ((iv_a, IV_A), (iv_b, IV_B)):
        _pg.goto(f'{BASE}/#/join/{_code}')
        _pg.wait_for_selector('.composer', timeout=30000)
    check('both invite contexts drop the shared nearby tier', nearby_off(iv_a) and nearby_off(iv_b))
    for _pg in (iv_a, iv_b):
        _pg.locator('.topbar button[title*="devices & people"]').click()
        _pg.locator('label', has_text='Go online').locator('input[type=checkbox]').check()
    iv_b.locator('.composer .bar button[title^="Share your camera"]').click()
    check('the invitee is sharing its camera',
          bool(poll(lambda: iv_b.locator('.tiles .stage-tile.kind-cam').count() == 1, 15)))
    iv_name_b = iv_b.locator('.sidebar input[aria-label="This device name"]').input_value()
    iv_row = iv_a.locator('.sidebar .peer', has_text=iv_name_b).locator('button[title^="Connect to "]')
    check('the inviter finds the invitee in the online list', bool(poll(lambda: iv_row.count() == 1, 150)),
          iv_a.locator('.sidebar').inner_text()[:240])
    if iv_row.count() == 1:
        iv_row.click()
        iv_join = iv_b.locator('.sys button', has_text=f'Connect to {IV_A.upper()}')
        check('the invitee is asked to join', bool(poll(lambda: iv_join.count() == 1, 60)))
        iv_title = iv_join.get_attribute('title') or '' if iv_join.count() else ''
        check('the prompt says sharing stops and the current code room is left',
              'stops first' in iv_title and 'leaving any code room' in iv_title, iv_title)
        if iv_join.count():
            iv_join.click()
            check('accepting moves the invitee into the inviter room',
                  bool(poll(lambda: iv_b.locator('button.code-chip').inner_text().strip() == IV_A.upper(), 20)))
            check('and stops its camera before it gets there',
                  bool(poll(lambda: iv_b.locator('.tiles .stage-tile').count() == 0, 10)),
                  '%d tiles' % iv_b.locator('.tiles .stage-tile').count())
            iv_met = poll(lambda: 'accepted' in iv_a.locator('.feed').inner_text(), 90)
            check('the inviter sees the invitee arrive', bool(iv_met), iv_a.locator('.feed').inner_text()[-160:])
            check('and never receives its camera',
                  bool(iv_met) and not poll(lambda: iv_a.locator('.tiles .stage-tile').count() > 0, 8),
                  '%d tiles' % iv_a.locator('.tiles .stage-tile').count())
    ictx_a.close()
    ictx_b.close()

    # --- captions end with the share they transcribe, and follow its mute ---
    # Captions record a clone of the mic track, and stopping or muting the original leaves
    # a clone untouched: after the tile's stop the mic stayed captured with no control left
    # to release it, and a muted mic kept being transcribed. The page's clones are counted
    # through the prototype. Model downloads are refused: the clone's state is the output
    # here, and a download would only load the machine.
    TRACK_CLONES = """
      window.__clones = []
      const realClone = MediaStreamTrack.prototype.clone
      MediaStreamTrack.prototype.clone = function () {
        const c = realClone.call(this)
        window.__clones.push(c)
        return c
      }
    """
    cctx = browser.new_context()
    cctx.add_init_script(TRACK_CLONES)
    cctx.route(re.compile(r'huggingface\.co|hf\.co|cdn\.jsdelivr\.net'), lambda r: r.abort())
    cp = cctx.new_page()
    cp.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    cp.wait_for_selector('.composer', timeout=30000)
    cp.locator('.composer .bar button[title^="Share your camera"]').click()
    c_offer = cp.locator('.sys button', has_text='Turn on live captions')
    check('a camera share with sound offers captions', bool(poll(lambda: c_offer.count() == 1, 15)))
    c_offer.click()
    C_LIVE = "() => window.__clones.filter(t => t.kind === 'audio' && t.readyState === 'live')"
    check('captions start recording a clone of the mic', bool(poll(lambda: len(cp.evaluate(C_LIVE)) == 1, 15)))
    cp.locator('.composer .bar button[title="Mute your microphone"]').click()
    check('muting the mic mutes what captions record',
          cp.evaluate("() => window.__clones.filter(t => t.kind === 'audio').every(t => !t.enabled)"))
    cp.locator('.composer .bar button[title="Unmute your microphone"]').click()
    check('and unmuting resumes it',
          cp.evaluate("() => window.__clones.some(t => t.kind === 'audio' && t.readyState === 'live' && t.enabled)"))
    cp.locator('.stage-tile.kind-cam button[title^="Stop sharing "]').click()
    check("stopping the camera from its tile releases the captions' mic",
          bool(poll(lambda: len(cp.evaluate(C_LIVE)) == 0, 5)), '%d live clones' % len(cp.evaluate(C_LIVE)))
    check('and takes the captions strip down', not cp.locator('.captions').is_visible())
    cctx.close()

    # --- a received file still downloads after its room is left ---
    # The session revoked every blob URL it had handed out when it left, while the file
    # card stayed in the feed, so switching rooms broke each earlier Download link without
    # a word. Both contexts leave nearby, so the file reaches only this block's room.
    FL_CODE = 'x' + os.urandom(3).hex()
    FL_PNG = os.path.join(SNAP, f'wt-keep-{FL_CODE}.png')
    fl_bytes = make_png(FL_PNG, 64, 48)
    fctx_a = browser.new_context()
    fctx_b = browser.new_context(accept_downloads=True)
    fl_a, fl_b = fctx_a.new_page(), fctx_b.new_page()
    for _pg in (fl_a, fl_b):
        _pg.goto(f'{BASE}/#/join/{FL_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
    check('both file contexts drop the shared nearby tier', nearby_off(fl_a) and nearby_off(fl_b))
    fl_reach = poll(lambda: fl_a.evaluate(CODE_PEERS) >= 1
                    and 'connected' in (fl_a.locator('.topbar .badge').inner_text() or ''), 150)
    check('the file contexts share a code room', bool(fl_reach), fl_a.locator('.feed').inner_text()[-160:])
    fl_a.locator('input[type=file][accept="image/*"]').set_input_files(FL_PNG)
    fl_a.locator('.card button', has_text='Send to devices').last.click()
    fl_card = fl_b.locator('.feed-item', has=fl_b.locator('img.preview'))
    check('the file arrives', bool(poll(lambda: fl_card.count() == 1, 90)), fl_b.locator('.feed').inner_text()[-160:])
    fl_b.locator('.topbar button', has_text='Connect').click()
    fl_b.locator('.modal button', has_text='Stop code room').click()
    fl_b.keyboard.press('Escape')
    poll(lambda: fl_b.locator('button.code-chip').is_hidden(), 10)
    fl_href = fl_card.locator('a[download]').get_attribute('href') if fl_card.count() else ''
    fl_fail, fl_size = 'no card', -1
    if fl_card.count():
        with fl_b.expect_download(timeout=15000) as fl_dl:
            fl_card.locator('a[download]').click()
        fl_fail = fl_dl.value.failure()
        fl_size = os.path.getsize(fl_dl.value.path()) if not fl_fail else -1
    check('its Download link still works after the room is left', not fl_fail and fl_size == fl_bytes,
          f'failure={fl_fail!r} size={fl_size} expected {fl_bytes}')
    FL_LOADS = "h => new Promise(r => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = h })"
    fl_del = fl_card.locator('button.del')
    fl_had = fl_card.count() == 1
    if fl_had:
        fl_card.hover()
        fl_del.click()
        fl_del.click()
    check('removing the card frees the file', fl_had and fl_card.count() == 0 and not fl_b.evaluate(FL_LOADS, fl_href))
    fctx_a.close()
    fctx_b.close()

    # --- a double click on New random code leaves the device in the room it shows ---
    # A second switch issued while the first was still leaving joined its own room, and
    # the first then adopted that session under its own code, so the chip named a room the
    # device was not in and whoever used it never arrived. Both contexts leave nearby, so
    # the joiner can only be met through the code room.
    RC_START = 'x' + os.urandom(3).hex()
    rctx_a = browser.new_context()
    rctx_b = browser.new_context()
    rc_a = rctx_a.new_page()
    rc_a.goto(f'{BASE}/#/join/{RC_START}')
    rc_a.wait_for_selector('.composer', timeout=30000)
    check('the switching context drops the shared nearby tier', nearby_off(rc_a))
    rc_chip = lambda: rc_a.locator('button.code-chip').inner_text().strip().lower()
    poll(lambda: rc_chip() == RC_START, 20)
    rc_a.locator('.topbar button', has_text='Connect').click()
    rc_a.locator('.modal button', has_text='New random code').dblclick()
    rc_settled = poll(lambda: rc_chip() not in ('', RC_START) and rc_a.locator('.modal .code-big').inner_text().strip().lower() == rc_chip(), 20)
    rc_a.keyboard.press('Escape')
    rc_code = rc_chip()
    check('the chip settles on a new code', bool(rc_settled), rc_code)
    rc_b = rctx_b.new_page()
    rc_b.goto(f'{BASE}/#/join/{rc_code}')
    rc_b.wait_for_selector('.composer', timeout=30000)
    check('the joiner drops the shared nearby tier', nearby_off(rc_b))
    check('someone who uses the code the chip shows reaches the device',
          bool(poll(lambda: rc_a.evaluate(CODE_PEERS) >= 1, 150)), rc_a.locator('.sidebar').inner_text()[:200])
    rctx_a.close()
    rctx_b.close()

    # --- a paired device's history request is answered for paired devices ---
    # With sending to paired devices switched off, a paired device's request raises the
    # prompt, whose "Always" button turned on replay to code rooms instead: the device
    # that asked got nothing and every forwarded code started receiving the room's past.
    # The message is typed alone, so it waits in the outbox, and the page is reloaded,
    # which drops the outbox and keeps the stored transcript: the pair then first meets
    # the message through the replay being tested.
    HAS_HISTORY = """() => new Promise(res => {
      const r = indexedDB.open('wt-data')
      r.onupgradeneeded = () => r.result.createObjectStore('kv')
      r.onerror = () => res(false)
      r.onsuccess = () => {
        const db = r.result
        if (!db.objectStoreNames.contains('kv')) { db.close(); return res(false) }
        const q = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys()
        q.onsuccess = () => { db.close(); res(q.result.map(String).some(k => k.startsWith('history:'))) }
        q.onerror = () => { db.close(); res(false) }
      }
    })"""
    HP_CODE = 'x' + os.urandom(3).hex()
    hctx_a = browser.new_context()
    hctx_b = browser.new_context()
    hp_a = hctx_a.new_page()
    hp_a.goto(f'{BASE}/#/join/{HP_CODE}')
    hp_a.wait_for_selector('.composer', timeout=30000)
    check('the history context drops the shared nearby tier', nearby_off(hp_a))
    hp_text = 'hist' + os.urandom(3).hex()
    hp_a.locator('.composer textarea').fill(hp_text)
    hp_a.locator('.composer textarea').press('Enter')
    hp_a.locator('.topbar button', has_text='Connect').click()
    hp_a.wait_for_selector('.modal input[readonly]', timeout=10000)
    hp_a.locator('.modal label', has_text='Send them to my own paired devices').locator('input').uncheck()
    hp_link = hp_a.locator('.modal input[readonly]').input_value()
    hp_a.keyboard.press('Escape')
    check('the typed message is stored', bool(poll(lambda: hp_a.evaluate(HAS_HISTORY), 10)))
    hp_a.reload()
    hp_a.wait_for_selector('.composer', timeout=30000)
    hp_b = hctx_b.new_page()
    hp_b.goto(hp_link)
    hp_b.wait_for_selector('.composer', timeout=30000)
    hp_ask = hp_a.locator('.sys', has_text='asked for the')
    check("a paired device's request raises the prompt", bool(poll(lambda: hp_ask.count() == 1, 150)),
          hp_a.locator('.feed').inner_text()[-160:])
    hp_always = hp_ask.locator('button', has_text='Always for my devices')
    check('its Always button is for paired devices',
          hp_always.count() == 1 and hp_ask.locator('button', has_text='Always in code rooms').count() == 0,
          ' | '.join(hp_ask.locator('button').all_inner_texts()) if hp_ask.count() else '')
    if hp_always.count() == 1:
        hp_always.click()
        check('the device that asked receives the earlier messages',
              bool(poll(lambda: hp_b.locator('.sys', has_text='Replayed 1 earlier message').count() == 1
                        and hp_text in (hp_b.locator('.feed-item', has_text='replayed from').first.text_content() or ''), 60)),
              f"A={hp_a.locator('.feed').inner_text()[-200:]!r} B={hp_b.locator('.feed').inner_text()[-300:]!r}")
        hp_a.locator('.topbar button', has_text='Connect').click()
        hp_a.wait_for_selector('.modal input[readonly]', timeout=10000)
        check('sending to paired devices is now on',
              hp_a.locator('.modal label', has_text='Send them to my own paired devices').locator('input').is_checked())
        check('and code-room replay is still off',
              not hp_a.locator('.modal label', has_text='Send them to people who join by code').locator('input').is_checked())
        hp_a.keyboard.press('Escape')
    hctx_a.close()
    hctx_b.close()

    # --- a peer's roster controls keep their setting across a re-render ---
    # Every roster event rebuilds the rows, and the volume slider was rebuilt at full while
    # the peer stayed turned down. The sender's rename is the roster event here.
    RM_CODE = 'x' + os.urandom(3).hex()
    mctx_a = browser.new_context()
    mctx_b = browser.new_context()
    rm_a, rm_b = mctx_a.new_page(), mctx_b.new_page()
    for _pg in (rm_a, rm_b):
        _pg.goto(f'{BASE}/#/join/{RM_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.locator('.topbar button[title*="devices & people"]').click()
    rm_a.locator('.composer .bar button[title^="Share your microphone"]').click()
    rm_vol = rm_b.locator('.sidebar .peer input[type=range][aria-label^="Volume for"]')
    check("the viewer's roster offers the sender's volume", bool(poll(lambda: rm_vol.count() == 1, 150)),
          rm_b.locator('.sidebar').inner_text()[:200])
    if rm_vol.count() == 1:
        rm_vol.fill('0.3')
        rm_b.locator('.sidebar .peer button[title^="Mute "]').click()
        rm_new = 'rn' + os.urandom(3).hex()
        rm_a.locator('.sidebar input[aria-label="This device name"]').fill(rm_new)
        rm_a.locator('.sidebar input[aria-label="This device name"]').press('Enter')
        check("the sender's rename rebuilds the viewer's roster",
              bool(poll(lambda: rm_b.locator('.sidebar .peer', has_text=rm_new).count() == 1, 30)))
        rm_row = rm_b.locator('.sidebar .peer', has_text=rm_new)
        check('the rebuilt volume slider still shows the lowered volume',
              rm_row.locator('input[type=range]').input_value() == '0.3'
              and rm_b.evaluate("() => [...document.querySelectorAll('audio')].every(a => Math.abs(a.volume - 0.3) < 1e-6)"),
              rm_row.locator('input[type=range]').input_value() if rm_row.count() else '')
        check('and the rebuilt mute button still offers to unmute',
              rm_row.locator('button[title^="Unmute "]').count() == 1)
    mctx_a.close()
    mctx_b.close()

    # --- an answered history prompt leaves nothing behind in the feed ---
    # Answering removed the prompt's card but not the feed item around it, which kept a
    # gap and a focusable "Remove from feed" control with nothing left to remove. Both
    # answers that take the prompt away are driven, since they remove it by two paths. The
    # message is typed alone, so it goes only to the peers of this block's own room.
    EMPTY_ITEMS = ("() => [...document.querySelectorAll('.feed-item')]"
                   ".filter(w => [...w.children].every(c => c.matches('button.del'))).length")
    HQ_CODE = 'x' + os.urandom(3).hex()
    qctx_a = browser.new_context()
    hq_a = qctx_a.new_page()
    hq_a.goto(f'{BASE}/#/join/{HQ_CODE}')
    hq_a.wait_for_selector('.composer', timeout=30000)
    check('the prompting context drops the shared nearby tier', nearby_off(hq_a))
    hq_a.locator('.composer textarea').fill('prm' + os.urandom(3).hex())
    hq_a.locator('.composer textarea').press('Enter')
    hq_ask = hq_a.locator('.sys', has_text='asked for the')
    for hq_answer in ('No', 'Always in code rooms'):
        hq_ctx = browser.new_context()
        hq_peer = hq_ctx.new_page()
        hq_peer.goto(f'{BASE}/#/join/{HQ_CODE}')
        hq_peer.wait_for_selector('.composer', timeout=30000)
        hq_up = poll(lambda: hq_ask.count() == 1, 150)
        check(f'a joiner raises the history prompt ({hq_answer})', bool(hq_up), hq_a.locator('.feed').inner_text()[-160:])
        if hq_up:
            hq_ask.locator('button', has_text=hq_answer).click()
            check(f'answering {hq_answer} takes the prompt away', bool(poll(lambda: hq_ask.count() == 0, 5)))
            check(f'and leaves no empty feed item behind ({hq_answer})', hq_a.evaluate(EMPTY_ITEMS) == 0,
                  '%d empty' % hq_a.evaluate(EMPTY_ITEMS))
        hq_ctx.close()
    qctx_a.close()

    # --- the tool launcher fits a short viewport ---
    # On a landscape phone the grid is taller than the room above the composer's "/", and
    # it neither clamped nor scrolled, so the first rows sat above the screen edge. Each end
    # of the list has to be reachable by scrolling the panel and open its tool.
    lctx = browser.new_context(viewport={'width': 740, 'height': 360})
    lp = lctx.new_page()
    lp.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    lp.wait_for_selector('.composer', timeout=30000)
    lp.locator('.composer .bar button[title^="Tools (hover"]').hover()
    lp.wait_for_selector('.menu.tool-grid', timeout=5000)
    l_box = lp.locator('.menu.tool-grid').bounding_box()
    check('the launcher stays inside a 360px-tall viewport',
          l_box['y'] >= 0 and l_box['y'] + l_box['height'] <= 360, str(l_box))
    # Tools only: Share screen and Connect lead the list and open no card.
    l_tools = lp.locator('.menu.tool-grid button.tool-open[draggable="true"]')
    l_seen = {}
    for l_end, l_btn in (('last', l_tools.last), ('first', l_tools.first)):
        l_btn.scroll_into_view_if_needed()
        b = l_btn.bounding_box()
        l_seen[l_end] = b['y'] >= 0 and b['y'] + b['height'] <= 360
        check(f'the {l_end} tool can be scrolled onto the screen', l_seen[l_end], str(b))
    if l_seen['first']:
        l_cards = lp.locator('.feed details.card').count()
        l_tools.first.click()
        check('and pressing it opens the tool', bool(poll(lambda: lp.locator('.menu.tool-grid').count() == 0
                                                          and lp.locator('.feed details.card').count() > l_cards, 10)))
    lctx.close()

    # --- touch: the per-card delete control, driven by real taps ---
    # Every assertion above drives a desktop viewport with a mouse, so a control that does
    # nothing on a phone passes them all. Revealing it wherever there is no hover is the
    # other failure: that puts a trash icon on every card at once. Both the quiet state and
    # the working gesture are asserted, since either alone is a regression. 344px is a
    # foldable cover screen.
    # Placed after the peer harness and closed immediately, because a live context on this
    # public IP is a nearby peer to every other one.
    tctx = browser.new_context(viewport={'width': 344, 'height': 882}, has_touch=True,
                               is_mobile=True, device_scale_factor=3)
    tp = tctx.new_page()
    terrs = []
    tp.on('pageerror', lambda e: terrs.append(str(e)))
    tp.goto(BASE)
    tp.wait_for_selector('.composer', timeout=30000)
    tmm = tp.evaluate("() => ({hover: matchMedia('(hover: none)').matches,"
                      " coarse: matchMedia('(pointer: coarse)').matches})")
    check('touch context really reports no hover and a coarse pointer',
          tmm['hover'] and tmm['coarse'], str(tmm))
    for _msg in ('touch delete one', 'touch delete two', 'touch delete three'):
        tp.locator('.composer textarea').fill(_msg)
        tp.locator('.composer textarea').press('Enter')
        tp.wait_for_timeout(250)
    # Cards are addressed by their text, never by position: a nearby peer's cards land in
    # this feed too, and one arriving mid-block moved `.last` off the card under test.
    MINE = tp.locator('.feed-item', has_text='touch delete')
    _tn = MINE.count()
    check('touch: the feed has items to delete', _tn >= 3, f'{_tn} items')
    # Both directions are asserted on computed opacity, never on the node existing: the
    # control is in the DOM either way, so presence cannot tell them apart.
    _vis = tp.evaluate("""() => [...document.querySelectorAll('.feed-item > button.del')]
        .filter(d => parseFloat(getComputedStyle(d).opacity) > 0.05).length""")
    check('touch: no card wears a delete control until it is asked for',
          _vis == 0, f'{_vis} of {_tn} showing one')
    # ...and it still has to work. Tapping the card reveals and arms in one gesture.
    tcard = tp.locator('.feed-item', has_text='touch delete three')
    tcard.tap(position={'x': 40, 'y': 8})
    tp.wait_for_timeout(250)
    tdel = tcard.locator('button.del')
    _op = tdel.evaluate('d => getComputedStyle(d).opacity') if tdel.count() else 'absent'
    check('touch: tapping a card reveals that card\'s control',
          _op != 'absent' and float(_op) > 0.9, f'opacity={_op}')
    check('touch: exactly one card is revealed at a time',
          tp.locator('.feed-item.revealed').count() == 1,
          f'{tp.locator(".feed-item.revealed").count()} revealed')
    check('touch: the revealing tap arms it, announced and not only coloured',
          'armed' in (tdel.get_attribute('class') or '')
          and tdel.get_attribute('aria-pressed') == 'true',
          f'class={tdel.get_attribute("class")!r} pressed={tdel.get_attribute("aria-pressed")!r}')
    _tbefore = MINE.count()
    tdel.tap()
    check('touch: tapping the revealed control removes the card',
          bool(poll(lambda: MINE.count() == _tbefore - 1 and tcard.count() == 0, 3)),
          f'{MINE.count()} items, was {_tbefore}')
    # A tap that lands anywhere else has to put it away, or the quiet state only holds
    # until the first accidental tap and the icons come back one card at a time.
    MINE.first.tap(position={'x': 40, 'y': 8})
    tp.wait_for_timeout(200)
    check('touch: a card is revealed before the dismissing tap',
          tp.locator('.feed-item.revealed').count() == 1)
    tp.locator('.composer textarea').tap()
    tp.wait_for_timeout(250)
    check('touch: a tap outside puts the control away again',
          tp.locator('.feed-item.revealed').count() == 0,
          f'{tp.locator(".feed-item.revealed").count()} still revealed')
    # The devices & people drawer is the one topbar control with no second entry point, so
    # it has to survive the shedding order down to a foldable cover screen. The room link
    # sheds ahead of it because the address bar already carries the same invite.
    _rt = tp.locator('.topbar button.roster-toggle')
    check('touch: the devices & people button is on the bar at 344px',
          _rt.count() == 1 and _rt.is_visible(), f'count={_rt.count()}')
    _rt.tap()
    tp.wait_for_timeout(400)
    check('touch: it opens the drawer', tp.locator('.sidebar.open').count() == 1)
    # A flex row shrinks its children before it overflows, so "no overflow" alone passes
    # while a glyph is clipped inside its own button.
    for _w in (320, 344, 360, 380, 390):
        tp.set_viewport_size({'width': _w, 'height': 882})
        tp.wait_for_timeout(250)
        _bar = tp.evaluate("""() => { const t = document.querySelector('.topbar');
            const box = t.getBoundingClientRect();
            const kids = [...t.children].filter(k => getComputedStyle(k).display !== 'none');
            const rb = t.querySelector('button.roster-toggle');
            const pins = [...t.querySelectorAll('button.tool-pin:not([data-tool="connect"]), button.screen-share')];
            const cn = t.querySelector('button.tool-pin[data-tool="connect"]');
            return { over: t.scrollWidth - t.clientWidth,
                     clipped: kids.filter(k => k.scrollWidth > k.clientWidth + 1).map(k => k.className),
                     outside: kids.filter(k => k.getBoundingClientRect().right > box.right + 0.5).map(k => k.className),
                     roster: !!rb && getComputedStyle(rb).display !== 'none',
                     connect: !!cn && getComputedStyle(cn).display !== 'none',
                     pins: pins.length,
                     pinsShown: pins.filter(b => getComputedStyle(b).display !== 'none').length } }""")
        check(f'touch: topbar at {_w}px fits with nothing clipped or pushed off',
              _bar['over'] <= 0 and not _bar['clipped'] and not _bar['outside'],
              f"overflow={_bar['over']} clipped={_bar['clipped']} outside={_bar['outside']}")
        check(f'touch: the drawer toggle survives at {_w}px', _bar['roster'])
        check(f'touch: the Connect pin survives at {_w}px', _bar['connect'], str(_bar))
        # The fit above only means something while a text button is in the bar's DOM: the
        # screen button is built wherever getDisplayMedia exists, headless included, so it
        # is there and has to be shed, not absent.
        check(f'touch: the screen button is in the bar at {_w}px', _bar['pins'] >= 1, str(_bar))
        check(f'touch: pinned tools and the screen button are shed at {_w}px', _bar['pinsShown'] == 0, str(_bar))
    check('touch: no page error on the touch path', not terrs, ' | '.join(terrs)[:200])
    tctx.close()

    # --- pinned tools: launcher toggle, topbar button, persistence, the empty default ---
    # Its own context because the default is only observable on a profile that has never
    # written 'tool-pins'. Closed immediately: a live context on this public IP is a
    # nearby peer to every other one.
    pctx = browser.new_context(viewport={'width': 1280, 'height': 800})
    pp = pctx.new_page()
    perrs = []
    pp.on('pageerror', lambda e: perrs.append(str(e)))
    pp.goto(BASE)
    pp.wait_for_selector('.composer', timeout=30000)
    pp.wait_for_timeout(1200)

    def pin_ids():
        # Connect is seeded too and has its own checks below; these follow the rest.
        return pp.eval_on_selector_all('.topbar button.tool-pin:not([data-tool="connect"])',
                                       'els => els.map(e => e.dataset.tool)')

    def pin_toggle(name):
        # The pin control of one launcher item, addressed by the tool's visible name.
        return pp.locator('.menu.tool-grid .tool-item',
                          has=pp.locator('button.tool-open', has_text=name)).locator('button.pin-toggle')

    def open_launcher():
        pp.locator('.topbar button', has_text='Tools').hover()
        pp.wait_for_selector('.menu.tool-grid', timeout=3000)

    av_id = tool_id_for('studio')
    check('pin: a profile that never wrote the key starts with Share screen pinned and nothing else',
          pin_ids() == ['screen'], str(pin_ids()))
    open_launcher()
    # Share screen is a launcher entry like the tools: listed, pinned, and unpinnable.
    check('pin: the launcher lists Share screen as a pinned entry',
          pin_toggle('Share screen').count() == 1 and pin_toggle('Share screen').inner_text() == 'Unpin',
          '%d entries' % pin_toggle('Share screen').count())
    pin_toggle('Share screen').click()
    pp.wait_for_timeout(400)
    check('pin: Share screen comes off the bar when unpinned', pin_ids() == [], str(pin_ids()))
    pin_toggle('Studio').click()
    pp.wait_for_timeout(500)
    pp.keyboard.press('Escape')
    pp.wait_for_timeout(300)
    check('pin: pinning Studio from the launcher puts it on the bar', pin_ids() == [av_id], str(pin_ids()))
    sp = pp.locator('.topbar button.tool-pin[data-tool="%s"]' % av_id)
    check("pin: the button carries the tool's registered name and a title",
          sp.inner_text() == 'Studio' and 'screen' in (sp.get_attribute('title') or ''),
          '%r title=%r' % (sp.inner_text(), sp.get_attribute('title')))
    sp.click()
    try:
        pp.locator('details.card').last.locator('button', has_text='Publish camera').wait_for(timeout=10000)
    except Exception:
        pass
    check('pin: clicking the topbar button opens that tool',
          pp.locator('details.card').last.locator('button', has_text='Publish camera').count() == 1,
          pp.locator('details.card').last.inner_text()[:120])

    # Pinning a second tool has to reach the bar on the spot, not on the next load.
    open_launcher()
    check('pin: an unpinned tool offers to be pinned',
          pin_toggle('Base64').inner_text() == 'Pin'
          and pin_toggle('Base64').get_attribute('aria-pressed') == 'false',
          '%r' % pin_toggle('Base64').inner_text())
    pin_toggle('Base64').click()
    pp.wait_for_timeout(500)
    check('pin: pinning from the launcher adds the button with no reload',
          pin_ids() == [av_id, 'base64'], str(pin_ids()))
    check('pin: the launcher item flips to the pinned state',
          pin_toggle('Base64').inner_text() == 'Unpin'
          and pin_toggle('Base64').get_attribute('aria-pressed') == 'true',
          '%r' % pin_toggle('Base64').inner_text())
    pp.keyboard.press('Escape')
    pp.wait_for_timeout(300)
    pp.locator('.topbar button.tool-pin[data-tool="base64"]').click()
    pp.wait_for_timeout(800)
    check('pin: the newly pinned button opens its own tool',
          pp.locator('details.card summary', has_text='Base64').count() >= 1)

    pp.reload()
    pp.wait_for_selector('.composer', timeout=30000)
    pp.wait_for_timeout(1200)
    check('pin: both pins survive a reload', pin_ids() == [av_id, 'base64'], str(pin_ids()))

    open_launcher()
    pin_toggle('Base64').click()
    pp.wait_for_timeout(500)
    check('pin: unpinning takes the button off the bar', pin_ids() == [av_id], str(pin_ids()))
    pin_toggle('Studio').click()
    pp.wait_for_timeout(500)
    check('pin: the last pin comes off like any other', pin_ids() == [], str(pin_ids()))
    pp.keyboard.press('Escape')
    pp.reload()
    pp.wait_for_selector('.composer', timeout=30000)
    pp.wait_for_timeout(1200)
    check('pin: an unpinned tool stays unpinned across a reload', pin_ids() == [], str(pin_ids()))
    check('pin: Studio does not come back once unpinned',
          pp.locator('.topbar button.tool-pin[data-tool="%s"]' % av_id).count() == 0)
    # The seed is offered once. An unpinned Share screen must not be put back by the next
    # load, or unpinning it would only last until a reload.
    check('pin: an unpinned Share screen stays off the bar across reloads',
          pp.locator('.topbar button.screen-share').count() == 0)
    open_launcher()
    pin_toggle('Share screen').click()
    pp.wait_for_timeout(400)
    check('pin: Share screen can be pinned back', pin_ids() == ['screen'], str(pin_ids()))
    # A profile that saved its pins before Share screen existed gets it once. Simulated by
    # unpinning it and deleting the record of seeds already offered.
    pin_toggle('Share screen').click()
    pp.wait_for_timeout(400)
    pp.keyboard.press('Escape')
    pp.evaluate("""() => new Promise((res, rej) => {
      const r = indexedDB.open('wt-data')
      r.onerror = () => rej(r.error)
      r.onsuccess = () => { const tx = r.result.transaction('kv', 'readwrite')
        tx.objectStore('kv').delete('pin-seeds'); tx.oncomplete = () => { r.result.close(); res() } }
    })""")
    pp.reload()
    pp.wait_for_selector('.composer', timeout=30000)
    check('pin: saved pins from before the seed get Share screen once',
          bool(poll(lambda: pin_ids() == ['screen'], 5)), str(pin_ids()))
    # The launcher entry itself shares, with no card in between.
    pp.add_init_script(FAKE_SCREEN)
    pp.reload()
    pp.wait_for_selector('.composer', timeout=30000)
    open_launcher()
    pp.locator('.menu.tool-grid button.tool-open[data-tool="screen"]').click()
    check('pin: the launcher entry shares the screen in one press',
          bool(poll(lambda: pp.locator('.tiles .stage-tile.kind-screen').count() == 1, 10)))
    open_launcher()
    check('pin: the launcher entry reads Stop sharing while the screen is shared',
          'Stop sharing' in pp.locator('.menu.tool-grid button.tool-open[data-tool="screen"]').inner_text())
    pp.locator('.menu.tool-grid button.tool-open[data-tool="screen"]').click()
    check('pin: and one more press stops it',
          bool(poll(lambda: pp.locator('.tiles .stage-tile').count() == 0, 10)))
    check('pin: no page error on the pin path', not perrs, ' | '.join(perrs)[:200])
    pctx.close()

    # --- connect launcher entry: pinned by default, right after Tools, unpinnable ---
    cnctx = browser.new_context()
    cnp = cnctx.new_page()
    cnp.goto(BASE)
    cnp.wait_for_selector('.composer', timeout=30000)
    cnp.wait_for_timeout(2000)
    cnp.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")

    def cn_launcher():
        tb = cnp.locator('.topbar button', has_text='Tools')
        if tb.count():
            tb.first.hover()
        try:
            cnp.wait_for_selector('.menu.tool-grid', timeout=3000)
        except Exception:
            pass
        return cnp.locator('.menu.tool-grid').count() == 1

    def cn_open_connect():
        pin = cnp.locator('.topbar button.tool-pin[data-tool="connect"]')
        if pin.count():
            pin.first.click()
        else:
            cn_launcher()
            le = cnp.locator('.menu.tool-grid button.tool-open[data-tool="connect"]')
            if le.count():
                le.first.click()
        try:
            cnp.wait_for_selector('.modal[aria-label="Connect"]', timeout=5000)
            # The dialog is drawn in steps, and the room list after a store read: wait for it,
            # or a row read straight after opening comes back missing or empty.
            cnp.wait_for_selector('.modal .recent-rooms', timeout=5000)
        except Exception:
            pass
        return cnp.locator('.modal[aria-label="Connect"]').count() == 1

    def cn_chip():
        ch = cnp.locator('button.code-chip')
        return ch.inner_text().strip().upper() if ch.count() else ''

    def cn_join(code):
        dlg = cnp.locator('.modal[aria-label="Connect"]')
        inp = dlg.locator('input[aria-label="Join code"]')
        if inp.count() == 0:
            return False
        inp.first.fill(code)
        inp.first.press('Enter')
        return True

    def cn_close():
        cnp.keyboard.press('Escape')
        return bool(poll(lambda: cnp.locator('.modal[aria-label="Connect"]').count() == 0, 5))

    def cn_toggle():
        return cnp.locator('.menu.tool-grid div.tool-item', has=cnp.locator('button.tool-open[data-tool="connect"]')).locator('button.pin-toggle')

    cn_pin = cnp.locator('.topbar button.tool-pin[data-tool="connect"]')
    check('connect: pinned to the topbar by default', cn_pin.count() == 1, '%d pins' % cn_pin.count())
    check('connect: pin reads Connect', (cn_pin.inner_text().strip() if cn_pin.count() else '') == 'Connect',
          repr(cn_pin.inner_text()[:40] if cn_pin.count() else 'no pin'))
    cn_prev = cnp.evaluate("() => { const b = document.querySelector('.topbar button.tool-pin[data-tool=\"connect\"]'); const q = b ? b.previousElementSibling : null; return q ? q.textContent.trim() : null }")
    check('connect: pin sits right after Tools', cn_prev == 'Tools', repr(cn_prev))
    check('connect: launcher opens on hover', cn_launcher())
    cn_entry = cnp.locator('.menu.tool-grid button.tool-open[data-tool="connect"]')
    check('connect: launcher holds a Connect entry', cn_entry.count() == 1, '%d entries' % cn_entry.count())
    check('connect: entry reads with signal emoji', (cn_entry.inner_text() if cn_entry.count() else '') == '📡 Connect',
          repr(cn_entry.inner_text()[:40] if cn_entry.count() else 'no entry'))
    check('connect: entry carries one pin toggle', cn_toggle().count() == 1, '%d toggles' % cn_toggle().count())
    check('connect: pinned entry toggle offers Unpin', (cn_toggle().inner_text().strip() if cn_toggle().count() else '') == 'Unpin',
          repr(cn_toggle().inner_text()[:40] if cn_toggle().count() else 'no toggle'))
    check('connect: pinned entry toggle pressed', (cn_toggle().get_attribute('aria-pressed') if cn_toggle().count() else '') == 'true',
          repr(cn_toggle().get_attribute('aria-pressed') if cn_toggle().count() else 'no toggle'))
    if cn_entry.count():
        cn_entry.first.click()
    try:
        cnp.wait_for_selector('.modal[aria-label="Connect"]', timeout=5000)
    except Exception:
        pass
    check('connect: entry opens the Connect dialog', cnp.locator('.modal[aria-label="Connect"]').count() == 1,
          '%d dialogs' % cnp.locator('.modal[aria-label="Connect"]').count())
    check('connect: Escape closes the dialog', cn_close())
    # The stored ciphertext of one key, so a test can wait for a write to land: the encrypted
    # IndexedDB write runs after the click, and a reload issued first aborts it.
    STORED = """k => new Promise((res) => {
      const r = indexedDB.open('wt-data')
      r.onsuccess = () => {
        const q = r.result.transaction('kv').objectStore('kv').get(k)
        q.onsuccess = () => { const v = q.result; r.result.close(); res(v ? Array.from(v.iv).join(',') : null) }
      }
    })"""
    cn_pins_before = cnp.evaluate(STORED, 'tool-pins')
    cn_launcher()
    if cn_toggle().count():
        cn_toggle().first.click()
    check('connect: unpinning drops the topbar pin',
          bool(poll(lambda: cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count() == 0, 5)),
          '%d pins' % cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count())
    check('connect: the unpin is stored', bool(poll(lambda: cnp.evaluate(STORED, 'tool-pins') != cn_pins_before, 5)))
    cnp.reload()
    cnp.wait_for_selector('.composer', timeout=30000)
    cnp.wait_for_timeout(2000)
    cnp.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
    check('connect: unpinned stays off the bar after reload',
          cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count() == 0,
          '%d pins' % cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count())
    cn_launcher()
    check('connect: unpinned entry toggle offers Pin', (cn_toggle().inner_text().strip() if cn_toggle().count() else '') == 'Pin',
          repr(cn_toggle().inner_text()[:40] if cn_toggle().count() else 'no toggle'))
    if cn_toggle().count():
        cn_toggle().first.click()
    check('connect: re-pin restores the topbar pin',
          bool(poll(lambda: cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count() == 1, 5)),
          '%d pins' % cnp.locator('.topbar button.tool-pin[data-tool="connect"]').count())
    cnp.mouse.click(400, 300)
    poll(lambda: cnp.locator('.menu.tool-grid').count() == 0, 5)
    cnctx.close()

    # --- recent rooms in Connect: listed newest first, named, rejoined in one press ---
    # The helpers above read `cnp` when called, so they drive this context's page.
    cnctx = browser.new_context()
    cnp = cnctx.new_page()
    cnp.goto(BASE)
    cnp.wait_for_selector('.composer', timeout=30000)
    cnp.wait_for_timeout(2000)
    cnp.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
    CODE_A = 'r' + os.urandom(3).hex()
    CODE_B = 'r' + os.urandom(3).hex()
    check('rooms: opening Connect for join A', cn_open_connect())
    check('rooms: join input taken for A', cn_join(CODE_A))
    check('rooms: chip shows A after join', bool(poll(lambda: cn_chip() == CODE_A.upper(), 20)), cn_chip())
    check('rooms: join input taken for B', cn_join(CODE_B))
    check('rooms: chip shows B after join', bool(poll(lambda: cn_chip() == CODE_B.upper(), 20)), cn_chip())
    check('rooms: dialog closed before reopen', cn_close())
    check('rooms: Connect reopens on the room list', cn_open_connect())
    cn_dlg = cnp.locator('.modal[aria-label="Connect"]')
    cn_groups = cn_dlg.locator('.group-label').all_inner_texts() if cn_dlg.locator('.group-label').count() else []
    check('rooms: recent group label shown', any('rooms you were in' in t.lower() for t in cn_groups), repr(cn_groups)[:160])
    cn_row_a = cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_A)
    cn_row_b = cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_B)
    check('rooms: row A listed', bool(poll(lambda: cn_row_a.count() == 1, 5)), '%d rows' % cn_row_a.count())
    check('rooms: row B listed', cn_row_b.count() == 1, '%d rows' % cn_row_b.count())
    cn_order = cnp.evaluate("() => [...document.querySelectorAll('.modal .recent-room')].map(e => e.dataset.code)")
    check('rooms: newest room sorts first', cn_order[:2] == [CODE_B, CODE_A], repr(cn_order[:4]))
    check('rooms: B row is current', 'current' in (cn_row_b.get_attribute('class') if cn_row_b.count() else '' or ''),
          repr(cn_row_b.get_attribute('class') if cn_row_b.count() else 'no row'))
    check('rooms: current row says You are here', 'You are here' in (cn_row_b.inner_text() if cn_row_b.count() else ''),
          repr((cn_row_b.inner_text() if cn_row_b.count() else 'no row')[:80]))
    check('rooms: current row has no Join button',
          (cn_row_b.locator('button[title="Join room %s"]' % CODE_B.upper()).count() if cn_row_b.count() else -1) == 0,
          'join=%d' % (cn_row_b.locator('button[title="Join room %s"]' % CODE_B.upper()).count() if cn_row_b.count() else -1))
    check('rooms: A row offers Join with room title',
          (cn_row_a.locator('button[title="Join room %s"]' % CODE_A.upper()).count() if cn_row_a.count() else 0) == 1,
          'join=%d' % (cn_row_a.locator('button[title="Join room %s"]' % CODE_A.upper()).count() if cn_row_a.count() else -1))
    for _code, _tag in ((CODE_A, 'A'), (CODE_B, 'B')):
        _row = cnp.locator('.modal .recent-room[data-code="%s"]' % _code)
        check('rooms: %s row offers an invite copy' % _tag,
              (_row.locator('button[title="Copy the invite link for room %s"]' % _code.upper()).count() if _row.count() else 0) == 1,
              'copy=%d' % (_row.locator('button[title="Copy the invite link for room %s"]' % _code.upper()).count() if _row.count() else -1))
        check('rooms: %s row offers Forget' % _tag,
              (_row.locator('button[title="Forget room %s"]' % _code.upper()).count() if _row.count() else 0) == 1,
              'forget=%d' % (_row.locator('button[title="Forget room %s"]' % _code.upper()).count() if _row.count() else -1))
        check('rooms: %s row has a name field' % _tag,
              (_row.locator('input[aria-label="Name for room %s"]' % _code.upper()).count() if _row.count() else 0) == 1,
              'name=%d' % (_row.locator('input[aria-label="Name for room %s"]' % _code.upper()).count() if _row.count() else -1))
    cn_first_nc = cnp.evaluate("() => { const r = document.querySelector('.modal .recent-room:not(.current)'); return r ? r.dataset.code : null }")
    check('rooms: A is the first non-current row', cn_first_nc == CODE_A, repr(cn_first_nc))
    cn_name_a = cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper())
    if cn_name_a.count():
        cn_name_a.first.fill('Team')
        cn_name_a.first.press('Tab')
    check('rooms: typed name stays in the field',
          bool(poll(lambda: (cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).input_value()
                              if cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).count() else '') == 'Team', 5)),
          repr(cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).input_value()
               if cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).count() else 'no field'))
    # A fresh render reads the list from the store, so seeing the name there means the write
    # landed; reloading before that tests the race against the reload instead.
    cn_close()
    cn_open_connect()
    check('rooms: the name is in the stored list',
          bool(poll(lambda: cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).count() == 1
                    and cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper()).input_value() == 'Team', 5)))
    check('rooms: dialog closed before reload', cn_close())
    cnp.reload()
    cnp.wait_for_selector('.composer', timeout=30000)
    cnp.wait_for_timeout(2000)
    cnp.evaluate("() => window.dispatchEvent(new CustomEvent('wt:nearby', { detail: false }))")
    check('rooms: chip still shows B after reload', bool(poll(lambda: cn_chip() == CODE_B.upper(), 20)), cn_chip())
    check('rooms: Connect reopens after reload', cn_open_connect())
    cn_name_a2 = cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper())
    check('rooms: A name survives reload', (cn_name_a2.input_value() if cn_name_a2.count() else '') == 'Team',
          repr(cn_name_a2.input_value() if cn_name_a2.count() else 'no field'))
    cn_row_a2 = cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_A)
    cn_join_a = cn_row_a2.locator('button[title="Join room %s"]' % CODE_A.upper())
    check('rooms: A row still offers Join after reload', cn_join_a.count() == 1, 'join=%d' % cn_join_a.count())
    if cn_join_a.count():
        cn_join_a.first.click()
    check('rooms: chip shows A after list Join', bool(poll(lambda: cn_chip() == CODE_A.upper(), 20)), cn_chip())
    check('rooms: A row becomes current',
          bool(poll(lambda: 'current' in (cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_A).get_attribute('class') or ''), 10)),
          repr(cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_A).get_attribute('class')
               if cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_A).count() else 'no row'))
    cn_row_b2 = cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_B)
    check('rooms: B row then offers Join',
          bool(poll(lambda: cn_row_b2.locator('button[title="Join room %s"]' % CODE_B.upper()).count() == 1, 10)),
          'join=%d' % cn_row_b2.locator('button[title="Join room %s"]' % CODE_B.upper()).count())
    cn_forget_b = cn_row_b2.locator('button[title="Forget room %s"]' % CODE_B.upper())
    check('rooms: B row has a Forget button', cn_forget_b.count() == 1, 'forget=%d' % cn_forget_b.count())
    if cn_forget_b.count():
        cn_forget_b.first.click()
    check('rooms: Forget removes the B row',
          bool(poll(lambda: cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_B).count() == 0, 10)),
          '%d rows' % cnp.locator('.modal .recent-room[data-code="%s"]' % CODE_B).count())
    # Edits to the list read it, change it and write it whole. A rename is committed by the
    # blur that a click elsewhere causes, so renaming one room and pressing Forget on another
    # starts two edits in the same moment; run side by side, the second write would drop the
    # first edit.
    CODE_C = 'r' + os.urandom(3).hex()
    if cn_join(CODE_C):
        poll(lambda: cn_chip() == CODE_C.upper(), 20)
    cn_close()
    cn_open_connect()
    cn_other = cnp.evaluate("a => { const r = [...document.querySelectorAll('.modal .recent-room:not(.current)')].find(x => x.dataset.code !== a); return r ? r.dataset.code : null }", CODE_A)
    cn_name_a3 = cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper())
    cn_forget_o = cnp.locator('.modal button[title="Forget room %s"]' % (cn_other or '').upper())
    if cn_other and cn_name_a3.count() and cn_forget_o.count():
        cn_name_a3.first.fill('Later')
        cn_forget_o.first.click()
    check('rooms: a third room is there to forget', bool(cn_other), repr(cn_other))
    poll(lambda: cnp.locator('.modal .recent-room[data-code="%s"]' % cn_other).count() == 0, 5)
    cn_close()
    cn_open_connect()
    cn_name_a4 = cnp.locator('.modal input[aria-label="Name for room %s"]' % CODE_A.upper())
    check('rooms: a rename and a Forget made together both land',
          bool(poll(lambda: cn_name_a4.count() == 1 and cn_name_a4.input_value() == 'Later', 5))
          and cnp.locator('.modal .recent-room[data-code="%s"]' % cn_other).count() == 0,
          'name=%r other rows=%d' % (cn_name_a4.input_value() if cn_name_a4.count() else 'no field',
                                     cnp.locator('.modal .recent-room[data-code="%s"]' % cn_other).count()))
    cn_close()
    cnp.reload()
    cnp.wait_for_selector('.composer', timeout=30000)
    cn_open_connect()
    check('rooms: and both survive a reload',
          bool(poll(lambda: cn_name_a4.count() == 1 and cn_name_a4.input_value() == 'Later', 5))
          and cnp.locator('.modal .recent-room[data-code="%s"]' % cn_other).count() == 0,
          repr(cn_name_a4.input_value() if cn_name_a4.count() else 'no field'))
    cn_close()
    cnctx.close()

    # --- feed images keep their aspect ratio and open at full size ---
    # The preview sits in a flex column whose default stretch widened an image narrower than
    # the column to its full width while max-height capped the height: a portrait image
    # came out stretched sideways.
    ictx = browser.new_context(viewport={'width': 1280, 'height': 900})
    ipg = ictx.new_page()
    ipg.goto(BASE)
    ipg.wait_for_selector('.composer', timeout=30000)
    for _name, _w, _h in (('wide', 1600, 400), ('tall', 300, 900)):
        make_png(os.path.join(SNAP, f'e2e-aspect-{_name}.png'), _w, _h)
        ipg.locator('input[type=file][accept="image/*"]').set_input_files(os.path.join(SNAP, f'e2e-aspect-{_name}.png'))
    IMG_RATIOS = ("() => [...document.querySelectorAll('.feed img.preview')].filter(i => i.complete && i.naturalWidth)"
                  ".map(i => { const r = i.getBoundingClientRect(); return { nat: i.naturalWidth / i.naturalHeight, shown: r.width / r.height } })")
    i_ratios = poll(lambda: (lambda r: r if len(r) >= 2 else None)(ipg.evaluate(IMG_RATIOS)), 15) or []
    check('feed images: both previews render', len(i_ratios) >= 2, str(i_ratios))
    check('feed images: each preview keeps its aspect ratio',
          bool(i_ratios) and all(abs(r['shown'] / r['nat'] - 1) < 0.04 for r in i_ratios), str(i_ratios))
    ipg.locator('.feed img.preview').first.click()
    i_full = ipg.evaluate("() => { const c = document.querySelector('.lightbox canvas'); return c ? [c.width, c.height] : null }")
    check('feed images: pressing a preview shows the image at its full size', i_full == [1600, 400], str(i_full))
    ipg.keyboard.press('Escape')
    check('feed images: Escape puts the full-size view away', bool(poll(lambda: ipg.locator('.lightbox').count() == 0, 3)))
    # The same by keyboard: the preview takes focus, Enter opens it, Tab stays inside the
    # dialog, and closing hands focus back to the preview.
    ipg.locator('.feed img.preview').first.focus()
    ipg.keyboard.press('Enter')
    i_kb = poll(lambda: ipg.locator('.lightbox canvas').count() == 1, 3)
    ipg.keyboard.press('Tab')
    i_in = ipg.evaluate("() => !!document.activeElement && !!document.activeElement.closest('.lightbox')")
    ipg.keyboard.press('Escape')
    i_back = ipg.evaluate("() => document.activeElement && document.activeElement.matches('.feed img.preview')")
    check('feed images: a preview opens by keyboard, keeps focus inside and returns it on close',
          bool(i_kb) and i_in and i_back, f'opened={bool(i_kb)} inside={i_in} returned={i_back}')
    ictx.close()

    # --- an expanded stage hides the composer, apart from your own live controls ---
    # While a screen has the expanded stage, a viewer sees nothing but the stream. Controls
    # for sources of your own that are live (mute, camera off, stop) are the ones kept.
    TH_CODE = 'x' + os.urandom(3).hex()
    thctx_a = browser.new_context(viewport={'width': 1280, 'height': 800})
    thctx_a.add_init_script(FAKE_SCREEN)
    thctx_b = browser.new_context(viewport={'width': 1280, 'height': 800}, permissions=['microphone', 'camera'])
    th_a, th_b = thctx_a.new_page(), thctx_b.new_page()
    for _pg in (th_a, th_b):
        _pg.goto(f'{BASE}/#/join/{TH_CODE}')
        _pg.wait_for_selector('.composer', timeout=30000)
        _pg.evaluate("() => window.dispatchEvent(new CustomEvent('wt:cover-video', { detail: false }))")
    COMPOSER_VIS = ("() => { const vis = e => !!e && getComputedStyle(e).display !== 'none' && e.getClientRects().length > 0;"
                    " return { wrap: vis(document.querySelector('.composer-wrap')), ta: vis(document.querySelector('.composer textarea')),"
                    " shown: [...document.querySelectorAll('.composer .bar > *')].filter(vis).map(e => e.title) } }")
    TH_MAX = "document.documentElement.classList.contains('stage-max')"
    th_reach = poll(lambda: 'connected' in (th_b.locator('.topbar .badge').inner_text() or ''), 150)
    check('theater: the two contexts reach each other', bool(th_reach))
    th_b.locator('.composer .bar button[title^="Share your microphone"]').click()
    poll(lambda: th_b.locator('.composer .bar button[title="Mute your microphone"]').is_visible(), 10)
    th_a.locator('.topbar button.screen-share').click()
    th_max = poll(lambda: th_b.evaluate(TH_MAX), 60)
    check('theater: a screen arriving expands the viewer stage', bool(th_max))
    th_v = th_b.evaluate(COMPOSER_VIS)
    check("theater: the viewer's composer is gone apart from its live mic controls",
          th_v['wrap'] and not th_v['ta']
          and sorted(th_v['shown']) == ['Mute your microphone', 'Stop sharing cam/mic/screen'], str(th_v))
    th_b.locator('.composer .bar button[title*="Stop sharing"]').click()
    th_v2 = poll(lambda: (lambda v: v if not v['wrap'] else None)(th_b.evaluate(COMPOSER_VIS)), 10)
    check('theater: with nothing of its own live the viewer sees no composer at all', bool(th_v2), str(th_b.evaluate(COMPOSER_VIS)))
    th_s = th_a.evaluate(COMPOSER_VIS)
    check('theater: the sharer keeps only the stop control',
          th_s['wrap'] and not th_s['ta'] and th_s['shown'] == ['Stop sharing cam/mic/screen'], str(th_s))
    th_b.locator('.tiles-head button[title*="Collapse"]').click()
    check('theater: collapsing the stage brings the composer back',
          bool(poll(lambda: th_b.evaluate(COMPOSER_VIS)['ta'], 5)), str(th_b.evaluate(COMPOSER_VIS)))
    thctx_a.close()
    thctx_b.close()

    # --- composer collapse: a manual, persisted toggle that keeps the control row ---
    # Collapsing is deliberately not wired to sharing: it only ever moves when the toggle
    # is clicked, so this drives the toggle and nothing else.
    kctx = browser.new_context()
    kpg = kctx.new_page()
    kerrs = []
    kpg.on('pageerror', lambda e: kerrs.append(str(e)))
    kpg.goto(BASE)
    kpg.wait_for_selector('.composer', timeout=30000)
    kpg.wait_for_timeout(1200)

    ktoggle = kpg.locator('.composer .bar button.composer-toggle')
    kta = kpg.locator('.composer textarea')

    def kh(sel):
        return kpg.eval_on_selector(sel, 'e => e.getBoundingClientRect().height')

    def kshut():
        return kpg.eval_on_selector('.composer-wrap', "e => e.classList.contains('composer-collapsed')")

    check('composer: the collapse toggle sits on the control row', ktoggle.count() == 1)
    check('composer: it starts expanded and reports that state',
          not kshut() and ktoggle.get_attribute('aria-expanded') == 'true',
          str(ktoggle.get_attribute('aria-expanded')))

    # Grow the box before measuring: a one-line composer gives back too little height to
    # tell a real collapse apart from sub-pixel layout noise.
    kta.click()
    kpg.keyboard.type('draft line one')
    for _ in range(3):
        kpg.keyboard.press('Shift+Enter')
        kpg.keyboard.type('another draft line')
    kpg.wait_for_timeout(400)
    open_ta, open_wrap, open_feed = kh('.composer textarea'), kh('.composer-wrap'), kh('.feed')
    check('composer: typing grows the box, so autosize is live while expanded',
          open_ta > 55, str(open_ta))

    ktoggle.click()
    kpg.wait_for_timeout(400)
    shut_wrap, shut_feed = kh('.composer-wrap'), kh('.feed')
    check('composer: clicking the toggle collapses it', kshut() and not kta.is_visible())
    check('composer: the toggle flips to the expand state',
          ktoggle.get_attribute('aria-expanded') == 'false' and ktoggle.inner_text().strip() != '',
          str(ktoggle.get_attribute('aria-expanded')))
    check('composer: collapsing gives up the typing area',
          shut_wrap < open_wrap - 40, '%.1f -> %.1f' % (open_wrap, shut_wrap))
    check('composer: the feed takes the height the composer gave up',
          shut_feed > open_feed + 40, '%.1f -> %.1f' % (open_feed, shut_feed))
    # The min-content floor on .composer-wrap is what stops the feed squeezing the bar off
    # screen. Collapsing has to shrink under it by removing content, never by lifting it.
    check('composer: the collapsed row is still floored at the control bar',
          shut_wrap >= kh('.composer .bar'), '%.1f vs bar %.1f' % (shut_wrap, kh('.composer .bar')))
    check('composer: Send and the share controls stay reachable while collapsed',
          kpg.locator('.composer .bar button.primary').is_visible()
          and kpg.locator('.composer .bar button[title^="Share your screen"]').is_visible()
          and kpg.locator('.composer .bar button[title*="Stop sharing"]').is_visible()
          and ktoggle.is_visible())

    # send() clears the draft and re-runs autosize. A display:none textarea reports
    # scrollHeight 0, so without the guard this real click leaves `height: 0px` inline.
    kpg.locator('.composer .bar button.primary').click()
    kpg.wait_for_timeout(700)
    check('composer: Send still sends the draft while collapsed',
          'another draft line' in kpg.locator('.feed').inner_text())
    check('composer: autosize does not write a zero height while collapsed',
          kpg.eval_on_selector('.composer textarea', 'e => e.style.height') not in ('0px', ''),
          str(kpg.eval_on_selector('.composer textarea', 'e => e.style.height')))

    kpg.reload()
    kpg.wait_for_selector('.composer', timeout=30000)
    kpg.wait_for_timeout(1200)
    check('composer: the collapsed state survives a reload',
          kshut() and not kpg.locator('.composer textarea').is_visible())
    check('composer: the reloaded toggle offers to expand',
          kpg.locator('.composer .bar button.composer-toggle').get_attribute('aria-expanded') == 'false')

    kpg.locator('.composer .bar button.composer-toggle').click()
    kpg.wait_for_timeout(400)
    check('composer: expanding restores the typing area',
          not kshut() and kpg.locator('.composer textarea').is_visible())
    check('composer: the row is back to its expanded height',
          kh('.composer-wrap') > shut_wrap + 10, '%.1f vs collapsed %.1f' % (kh('.composer-wrap'), shut_wrap))
    kmsg = 'expanded again probe ' + os.urandom(3).hex()
    kpg.locator('.composer textarea').click()
    kpg.keyboard.type(kmsg)
    kpg.keyboard.press('Enter')
    kpg.wait_for_timeout(700)
    check('composer: the restored textarea still sends a message',
          kmsg in kpg.locator('.feed').inner_text(), kmsg)
    # Autosize has to be live again, not left switched off by the collapse.
    kpg.locator('.composer textarea').click()
    back_one = kh('.composer textarea')
    kpg.keyboard.type('a')
    for _ in range(3):
        kpg.keyboard.press('Shift+Enter')
        kpg.keyboard.type('a')
    kpg.wait_for_timeout(400)
    check('composer: autosize runs again once expanded',
          kh('.composer textarea') > back_one + 20, '%.1f -> %.1f' % (back_one, kh('.composer textarea')))
    check('composer: no page error on the collapse path', not kerrs, ' | '.join(kerrs)[:200])
    kctx.close()

    # --- on-screen keyboard: the shell insets by the occluded strip ---
    # A headless browser cannot raise a real keyboard, so this covers only our half of the
    # contract: a visualViewport that shrinks by N moves the composer out from under the
    # occluded strip and leaves the feed on screen. Whether the platform reports that
    # geometry is out of scope. Driven through a stub installed before the app boots.
    VV_STUB = """
    window.__vvH = window.innerHeight; window.__vvTop = 0;
    const t = new EventTarget();
    const fake = {
      get height() { return window.__vvH }, get width() { return window.innerWidth },
      get offsetTop() { return window.__vvTop }, get offsetLeft() { return 0 },
      get pageTop() { return window.__vvTop }, get pageLeft() { return 0 }, get scale() { return 1 },
      addEventListener: t.addEventListener.bind(t),
      removeEventListener: t.removeEventListener.bind(t),
      dispatchEvent: t.dispatchEvent.bind(t) };
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
    window.__setVV = (h, top) => { window.__vvH = h; window.__vvTop = top || 0;
      fake.dispatchEvent(new Event('resize')); fake.dispatchEvent(new Event('scroll')) };
    """
    kctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    kp = kctx.new_page()
    kerrs = []
    kp.on('pageerror', lambda e: kerrs.append(str(e)))
    kp.add_init_script(VV_STUB)
    kp.goto(BASE)
    kp.wait_for_selector('.composer', timeout=30000)
    kp.wait_for_timeout(1200)
    for _i in range(8):
        kp.locator('.composer textarea').fill(f'keyboard filler line {_i}')
        kp.locator('.composer textarea').press('Enter')
        kp.wait_for_timeout(120)
    KB_PX = 320
    krest = kp.evaluate("""() => {
      const cw = document.querySelector('.composer-wrap').getBoundingClientRect()
      return {inset: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
              bottom: Math.round(cw.bottom), inner: window.innerHeight} }""")
    check('keyboard: an unoccluded viewport insets the shell by nothing',
          krest['inset'] == '0px', str(krest))
    check('keyboard: at rest the composer is inside the viewport',
          krest['bottom'] <= krest['inner'] + 1, str(krest))
    kp.evaluate(f"window.__setVV(window.innerHeight - {KB_PX}, 0)")
    kp.wait_for_timeout(400)
    kopen = kp.evaluate("""() => {
      const cw = document.querySelector('.composer-wrap').getBoundingClientRect()
      const f = document.querySelector('.feed').getBoundingClientRect()
      const vv = window.visualViewport
      return {inset: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim(),
              composerBottom: Math.round(cw.bottom), feedH: Math.round(f.height),
              visibleBottom: Math.round(vv.offsetTop + vv.height)} }""")
    check('keyboard: the shell insets by the occluded height',
          kopen['inset'].endswith('px') and abs(float(kopen['inset'][:-2]) - KB_PX) <= 2, str(kopen))
    check('keyboard: the composer bottom stays inside the visible area',
          kopen['composerBottom'] <= kopen['visibleBottom'] + 1, str(kopen))
    # Insetting has to keep the conversation too. Scrolling the field into view inside a
    # shell that clips its overflow buys the composer at the feed's expense.
    check('keyboard: the feed is still on screen with the keyboard up',
          kopen['feedH'] > 40, str(kopen))
    kp.evaluate("window.__setVV(window.innerHeight, 0)")
    kp.wait_for_timeout(400)
    kclosed = kp.evaluate("() => getComputedStyle(document.documentElement)"
                          ".getPropertyValue('--kb-inset').trim()")
    check('keyboard: dismissing it gives the shell its height back', kclosed == '0px', repr(kclosed))
    check('keyboard: no page error on the viewport path', not kerrs, ' | '.join(kerrs)[:200])
    kctx.close()

    # A browser without visualViewport (older Safari, any non-browser host) must still get
    # the unshifted layout, so the absent case is driven rather than reasoned about: the
    # property stays at its 0px token and nothing throws.
    nctx = browser.new_context(viewport={'width': 390, 'height': 844})
    npg = nctx.new_page()
    nerrs = []
    npg.on('pageerror', lambda e: nerrs.append(str(e)))
    npg.add_init_script("Object.defineProperty(window, 'visualViewport',"
                        " {configurable: true, get: () => undefined})")
    npg.goto(BASE)
    npg.wait_for_selector('.composer', timeout=30000)
    npg.wait_for_timeout(900)
    nres = npg.evaluate("""() => { const cw = document.querySelector('.composer-wrap').getBoundingClientRect()
      return {vv: typeof window.visualViewport, bottom: Math.round(cw.bottom), inner: window.innerHeight,
              inset: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim()} }""")
    check('no visualViewport: the keyboard handling is a complete no-op',
          nres['vv'] == 'undefined' and not nerrs and nres['inset'] == '0px'
          and nres['bottom'] <= nres['inner'] + 1, f'{nres} errs={nerrs}')
    nctx.close()

    # --- scroll-to-bottom control ---
    # addCard pins scrollTop to scrollHeight so the feed follows new content, but after
    # scrolling up there was no way back. Driven at a phone width because its one geometric
    # constraint, never sitting on a card's own delete button, is a phone problem: at 390px
    # that button moves inside the card.
    sctx = browser.new_context(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True)
    spg = sctx.new_page()
    serrs = []
    spg.on('pageerror', lambda e: serrs.append(str(e)))
    spg.goto(BASE)
    spg.wait_for_selector('.composer', timeout=30000)
    spg.wait_for_timeout(1200)
    JUMP = '.feed .jump-latest'
    FEED_DIST = ("() => { const f = document.querySelector('.feed');"
                 " return {dist: Math.round(f.scrollHeight - f.scrollTop - f.clientHeight),"
                 " over: Math.round(f.scrollHeight - f.clientHeight)} }")
    check('scroll: an empty feed has the control mounted and hidden',
          spg.locator(JUMP).count() == 1 and not spg.locator(JUMP).is_visible(),
          f'{spg.locator(JUMP).count()} in the DOM')
    for _i in range(26):
        spg.locator('.composer textarea').fill(f'scroll filler line {_i}')
        spg.locator('.composer textarea').press('Enter')
    # Every one of those sends toasts "message queued", and the toast host is a real
    # overlay across the lower half of the screen. Wait them out, or the hit tests below
    # answer a question about the toasts instead of the control.
    for _ in range(40):
        if spg.locator('#toasts > *').count() == 0:
            break
        spg.wait_for_timeout(250)
    spg.wait_for_timeout(400)
    check('scroll: the toasts cleared, so hit tests here are about the control',
          spg.locator('#toasts > *').count() == 0, f'{spg.locator("#toasts > *").count()} toasts up')
    srest = spg.evaluate(FEED_DIST)
    check('scroll: the feed really overflows and follows the newest item',
          srest['over'] > 200 and srest['dist'] <= 4, str(srest))
    check('scroll: the control stays hidden while the feed sits at the bottom',
          not spg.locator(JUMP).is_visible(), str(srest))
    # opacity:0 leaves an element invisible and still tappable, so the hidden state is
    # asserted out of the hit tree (visibility, pointer-events, elementFromPoint) rather
    # than merely transparent.
    shid = spg.evaluate("""() => { const b = document.querySelector('.feed .jump-latest')
      if (!b) return 'absent'
      const cs = getComputedStyle(b), r = b.getBoundingClientRect()
      return {vis: cs.visibility, pe: cs.pointerEvents,
              hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === b} }""")
    check('scroll: the hidden control is not a transparent tap target',
          shid != 'absent' and shid['vis'] == 'hidden' and shid['hit'] is False, str(shid))
    spg.evaluate("() => { document.querySelector('.feed').scrollTop = 0 }")
    spg.wait_for_timeout(400)
    check('scroll: the control appears once the feed is scrolled away from the bottom',
          spg.locator(JUMP).is_visible(), str(spg.evaluate(FEED_DIST)))
    sgeo = spg.evaluate("""() => {
      const b = document.querySelector('.feed .jump-latest')
      if (!b) return null
      const r = b.getBoundingClientRect()
      const card = document.querySelector('.feed-item').getBoundingClientRect()
      const comp = document.querySelector('.composer').getBoundingClientRect()
      const dels = [...document.querySelectorAll('.feed-item > .del')]
        .map(d => d.getBoundingClientRect())
        .filter(d => d.width > 0 && d.height > 0 && d.bottom > 0 && d.top < window.innerHeight)
        .map(d => ({x: d.x, y: d.y, w: d.width, h: d.height}))
      return {jump: {x: r.x, y: r.y, w: r.width, h: r.height}, dels: dels,
              cardLeft: card.left, cardRight: card.right,
              compTop: comp.top, compLeft: comp.left, compRight: comp.right} }""")
    sj = sgeo['jump'] if sgeo else None
    if not sgeo:
        check('scroll: the control has a box to measure', False, 'no .jump-latest in the DOM')
    else:
        sover = [d for d in sgeo['dels']
                 if sj['x'] < d['x'] + d['w'] and d['x'] < sj['x'] + sj['w']
                 and sj['y'] < d['y'] + d['h'] and d['y'] < sj['y'] + sj['h']]
        # Without this the overlap check below passes on a feed with no delete controls on
        # screen at all, which makes it a proxy rather than a test.
        check('scroll: there really are delete controls on screen to collide with',
              len(sgeo['dels']) >= 2, f"{len(sgeo['dels'])} on screen")
        check('scroll: the control does not overlap a delete control at 390px',
              not sover, f"{len(sover)} of {len(sgeo['dels'])} overlapped; jump={sj}")
        check('scroll: the control clears the composer',
              sj['y'] + sj['h'] <= sgeo['compTop'] + 1,
              f"jump bottom={sj['y'] + sj['h']} composer top={sgeo['compTop']}")
        # `scrollbar-gutter: stable both-edges` keeps the feed and the composer on one
        # column, and a control hanging outside that column breaks the alignment.
        check('scroll: the control stays inside the shared feed/composer column',
              sj['x'] >= max(sgeo['cardLeft'], sgeo['compLeft']) - 1
              and sj['x'] + sj['w'] <= min(sgeo['cardRight'], sgeo['compRight']) + 1,
              f"jump={sj} card=[{sgeo['cardLeft']},{sgeo['cardRight']}] "
              f"composer=[{sgeo['compLeft']},{sgeo['compRight']}]")
    if sj:
        stop = spg.evaluate("""() => { const b = document.querySelector('.feed .jump-latest')
          const r = b.getBoundingClientRect()
          const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
          return at === b ? true : (at ? at.className || at.tagName : 'nothing') }""")
        check('scroll: the visible control is the topmost thing at its own centre',
              stop is True, str(stop))
        # A real tap at real coordinates. locator.tap() scrolls its target into view
        # first, and for a sticky element that means scrolling the feed to the bottom,
        # which is the one thing that makes this control disappear before the tap lands.
        spg.touchscreen.tap(round(sj['x'] + sj['w'] / 2), round(sj['y'] + sj['h'] / 2))
    sland = spg.evaluate(FEED_DIST)
    for _ in range(24):
        spg.wait_for_timeout(150)
        sland = spg.evaluate(FEED_DIST)
        if sland['dist'] <= 4:
            break
    check('scroll: the control returns the feed to the bottom', sland['dist'] <= 4, str(sland))
    spg.wait_for_timeout(400)
    check('scroll: the control hides again once the feed is back at the bottom',
          not spg.locator(JUMP).is_visible(), str(spg.evaluate(FEED_DIST)))
    check('scroll: no page error on the scroll-control path', not serrs, ' | '.join(serrs)[:200])
    sctx.close()

    # --- clipboard: the app opens on the Clipboard tool, and keeps it current ---
    # Driven with real clipboard content through the real boot path rather than by mounting
    # a card, since the behaviour under test is what boot does with what was copied. The
    # headless clipboard is one surface for the whole browser, so this block writes known
    # content and blanks it again at the end.
    CLIP_TEXT = 'urletc clipboard boot probe ' + os.urandom(3).hex()
    CLIP_TEXT2 = 'urletc clipboard refocus probe ' + os.urandom(3).hex()
    CLIP_TOOL = '.feed-item details.card[data-tool="clipboard"]'
    WRITE_IMAGE = """async () => {
      const c = document.createElement('canvas'); c.width = 240; c.height = 90
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = '#000'; g.font = 'bold 34px Georgia, serif'; g.textBaseline = 'middle'
      g.fillText('clip img', 12, 46)
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      await navigator.clipboard.write([new ClipboardItem({'image/png': blob})])
      return blob.size }"""
    # Count reads at the API, so "nothing was read" rests on the call never happening
    # rather than on an absent card, which is also what a broken read looks like.
    COUNT_READS = """
      window.__clipReads = 0
      const orig = navigator.clipboard && navigator.clipboard.read
      if (orig) Object.defineProperty(navigator.clipboard, 'read', {configurable: true,
        value: function () { window.__clipReads++; return orig.apply(this, arguments) }})
    """

    # Cards rather than feed items: a peer connecting mid-window writes a `sys` line into
    # the same feed, and counting those makes "nothing was appended" fail for a reason
    # unrelated to the clipboard.
    def card_count(pg):
        return pg.locator('.feed-item details.card').count()

    gctx = browser.new_context(viewport={'width': 900, 'height': 820},
                               permissions=['clipboard-read', 'clipboard-write'])
    gpg = gctx.new_page()
    gerrs, gdialogs = [], []
    gpg.on('pageerror', lambda e: gerrs.append(str(e)))
    gpg.on('dialog', lambda d: (gdialogs.append(d.type), d.dismiss()))
    gpg.add_init_script(COUNT_READS)
    gpg.goto(BASE)
    gpg.wait_for_selector('.composer', timeout=30000)
    gpg.evaluate('t => navigator.clipboard.writeText(t)', CLIP_TEXT)
    check('clipboard: the probe text really is on the clipboard',
          gpg.evaluate('navigator.clipboard.readText()') == CLIP_TEXT)
    gpg.reload()
    gpg.wait_for_selector('.composer', timeout=30000)
    # Mount, a permission query, the read, the tool chunk and the tool's own read all come
    # before the text is on screen.
    try:
        gpg.wait_for_function('t => document.querySelector(".feed").innerText.includes(t)', arg=CLIP_TEXT,
                              timeout=20000)
    except Exception:
        pass
    gstate = gpg.evaluate("() => navigator.permissions.query({name: 'clipboard-read'}).then(s => s.state)")
    check('clipboard: the granted context really reports clipboard-read granted',
          gstate == 'granted', str(gstate))
    check('clipboard: boot really read the clipboard',
          (gpg.evaluate('window.__clipReads') or 0) >= 1, str(gpg.evaluate('window.__clipReads')))
    check('clipboard: boot opens the clipboard tool card, not a capability-detection card',
          gpg.locator(CLIP_TOOL).count() == 1,
          f'{gpg.locator(CLIP_TOOL).count()} tool cards; feed={feed_text(gpg)[:200]!r}')
    check('clipboard: the card shows the text that was on the clipboard',
          CLIP_TEXT in feed_text(gpg), feed_text(gpg)[:200])
    glead = gpg.evaluate(r"""(txt) => {
      const card = document.querySelector('.feed-item details.card[data-tool="clipboard"]')
      if (!card) return 'no clipboard tool card'
      const pre = [...card.querySelectorAll('pre')].find(p => p.textContent.includes(txt))
      const stat = [...card.querySelectorAll('div')].find(
        d => !d.children.length && /\d+ words, \d+ chars/.test(d.textContent))
      if (!pre || !stat) return {pre: !!pre, stat: !!stat}
      return {contentFirst: !!(pre.compareDocumentPosition(stat) & Node.DOCUMENT_POSITION_FOLLOWING),
              stat: stat.textContent.trim()} }""", CLIP_TEXT)
    check('clipboard: the text card leads with the text, not with the character count',
          isinstance(glead, dict) and glead.get('contentFirst') is True, str(glead))
    gsize = gpg.evaluate(WRITE_IMAGE)
    check('clipboard: an image really was written to the clipboard',
          isinstance(gsize, int) and gsize > 500, str(gsize))
    gcards = card_count(gpg)
    greads = gpg.evaluate('window.__clipReads')
    gpg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    gimg = False
    for _ in range(30):
        gpg.wait_for_timeout(250)
        if gpg.locator(CLIP_TOOL + ' img.preview').count() >= 1:
            gimg = True
            break
    check('clipboard: an image copied after load surfaces on refocus', gimg,
          f'feed={feed_text(gpg)[:200]!r}')
    # Mounting a preview is not reading the image. This branch rendered a manual Run OCR
    # button and ignored the auto-OCR mode, so an image on the clipboard was read
    # automatically in the feed and left untouched here. Default mode is 'copy', so assert
    # no button and the recognised text, not the presence of the card.
    _runocr = gpg.locator(CLIP_TOOL).locator('button', has_text='Run OCR')
    check('clipboard: the image card needs no Run OCR button in the default mode',
          _runocr.count() == 0, f'{_runocr.count()} buttons')
    _gpre = gpg.locator(CLIP_TOOL + ' pre')
    _gocr = ocr_settle(gpg, _gpre.last) if _gpre.count() else '(no output area)'
    check('clipboard: the image card reads the text out of the image',
          'clip' in _gocr.lower(), _gocr[:140])
    check('clipboard: refocus re-read the clipboard instead of reusing the boot read',
          (gpg.evaluate('window.__clipReads') or 0) > greads,
          f'{greads} reads before, {gpg.evaluate("window.__clipReads")} after')
    check('clipboard: surfacing it appended no second card',
          card_count(gpg) == gcards and gpg.locator(CLIP_TOOL).count() == 1,
          f'{card_count(gpg)} cards (was {gcards}), {gpg.locator(CLIP_TOOL).count()} tool cards')
    gcards2 = card_count(gpg)
    gpg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    gpg.wait_for_timeout(1500)
    check('clipboard: refocusing with unchanged content appends nothing',
          card_count(gpg) == gcards2 and gpg.locator(CLIP_TOOL).count() == 1,
          f'{card_count(gpg)} cards (was {gcards2}), {gpg.locator(CLIP_TOOL).count()} tool cards')
    check('clipboard: no page error on the granted path', not gerrs, ' | '.join(gerrs)[:200])
    check('clipboard: loading and refocusing raised no dialog', not gdialogs, str(gdialogs))
    gctx.close()

    # The half the console owns: with a blank clipboard at load there is no card, so
    # content copied later has to open one. The tool keeps an already-open card current via
    # its re-scan-on-focus switch, while the console decides whether there is a card at
    # all. Two owners for one job makes a tab collect a new card on every focus, so the
    # dedupe is asserted over repeated focuses.
    rctx = browser.new_context(viewport={'width': 900, 'height': 820},
                               permissions=['clipboard-read', 'clipboard-write'])
    rpg = rctx.new_page()
    rerrs = []
    rpg.on('pageerror', lambda e: rerrs.append(str(e)))
    rpg.goto(BASE)
    rpg.wait_for_selector('.composer', timeout=30000)
    rpg.evaluate("() => navigator.clipboard.writeText(' ')")
    rpg.reload()
    rpg.wait_for_selector('.composer', timeout=30000)
    rpg.wait_for_timeout(2000)
    check('clipboard: a blank clipboard opens nothing at boot',
          rpg.locator(CLIP_TOOL).count() == 0, feed_text(rpg)[:200])
    rpg.evaluate('t => navigator.clipboard.writeText(t)', CLIP_TEXT2)
    rpg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    ropened = False
    for _ in range(30):
        rpg.wait_for_timeout(250)
        if rpg.locator(CLIP_TOOL).count() >= 1 and CLIP_TEXT2 in feed_text(rpg):
            ropened = True
            break
    check('clipboard: content copied with no card open opens one on refocus', ropened,
          f'{rpg.locator(CLIP_TOOL).count()} tool cards; feed={feed_text(rpg)[:200]!r}')
    rcards = card_count(rpg)
    for _ in range(2):
        rpg.evaluate("() => window.dispatchEvent(new Event('focus'))")
        rpg.wait_for_timeout(1500)
    check('clipboard: two more refocuses with the same content add no second card',
          rpg.locator(CLIP_TOOL).count() == 1 and card_count(rpg) == rcards,
          f'{rpg.locator(CLIP_TOOL).count()} tool cards, {card_count(rpg)} cards (was {rcards})')
    check('clipboard: no page error on the refocus path', not rerrs, ' | '.join(rerrs)[:200])
    rctx.close()

    # The gate itself: without the permission nothing may be read, at boot or on refocus,
    # so neither loading the page nor returning to the tab can raise a prompt.
    uctx = browser.new_context(viewport={'width': 900, 'height': 820})
    upg = uctx.new_page()
    uerrs, udialogs = [], []
    upg.on('pageerror', lambda e: uerrs.append(str(e)))
    upg.on('dialog', lambda d: (udialogs.append(d.type), d.dismiss()))
    upg.add_init_script(COUNT_READS)
    upg.goto(BASE)
    upg.wait_for_selector('.composer', timeout=30000)
    upg.wait_for_timeout(2000)
    ustate = upg.evaluate("() => navigator.permissions.query({name: 'clipboard-read'}).then(s => s.state)")
    check('clipboard: the ungranted context really is not granted', ustate != 'granted', str(ustate))
    upg.evaluate("() => window.dispatchEvent(new Event('focus'))")
    upg.wait_for_timeout(1500)
    check('clipboard: without the permission the clipboard is never read',
          upg.evaluate('window.__clipReads') == 0, str(upg.evaluate('window.__clipReads')))
    check('clipboard: without the permission no card is opened',
          upg.locator(CLIP_TOOL).count() == 0, feed_text(upg)[:200])
    check('clipboard: without the permission nothing raises a dialog', not udialogs, str(udialogs))
    check('clipboard: no page error on the ungranted path', not uerrs, ' | '.join(uerrs)[:200])
    uctx.close()

    # --- clipboard: a URL on the clipboard, and the auto-copy switch ---
    # Boot opening the Clipboard tool card instead of a detection card moved the URL case
    # onto a surface that only ran parseUrl, so the card on arrival answered "what is in
    # this link" and never "is it safe", while the pasted-link card in the feed answered
    # the latter. Same order as the URL Check tool: blocklist, structural read, then parts.
    lctx = browser.new_context(viewport={'width': 900, 'height': 900},
                               permissions=['clipboard-read', 'clipboard-write'])
    lpg = lctx.new_page()
    lerrs = []
    lpg.on('pageerror', lambda e: lerrs.append(str(e)))
    lpg.goto(BASE)
    lpg.wait_for_selector('.composer', timeout=30000)
    lpg.evaluate("() => navigator.clipboard.writeText('https://urletc.vercel.app/docs')")
    lpg.evaluate("location.hash = '#/t/clipboard'")
    lpg.wait_for_selector(CLIP_TOOL, timeout=20000)
    lcard = lpg.locator(CLIP_TOOL).last
    _scan = lcard.locator('button', has_text='Scan clipboard')
    if _scan.count():
        _scan.first.click()
    try:
        lcard.locator('.url-check-structural').first.wait_for(timeout=20000)
    except Exception:
        pass
    check('clipboard: a URL on the clipboard gets the structural verdict, not just a parse',
          lcard.locator('.url-check-structural').count() >= 1,
          lcard.inner_text()[:220].replace('\n', ' / '))
    # The card says "Checking blocklist feeds..." until the lookup settles, so the answer
    # is read off the feed result, or off the placeholder once it names the feeds as down.
    def _lfeed():
        r = lcard.locator('.url-check-feedresult')
        if r.count():
            return r.first.inner_text()
        t = lcard.locator('.url-check-pending').all_inner_texts()
        return t[0] if t and t[0].startswith('Feeds unavailable') else None
    _lans = (poll(_lfeed, 30) or '').lower()
    check('clipboard: the blocklist answer is on the card',
          any(w in _lans for w in ('listed by', 'related listing', 'not on ', 'unavailable')),
          (_lans or lcard.inner_text().lower())[:220].replace('\n', ' / '))
    check('clipboard: the parts breakdown is kept, under the verdict and not instead of it',
          lcard.locator('.url-check-parts').count() >= 1)
    # The switch the console reads before it overwrites the clipboard with OCR output. The
    # contract is that it moves the preference the other surface reads, not that a checkbox
    # exists, so it is asserted in Settings in both directions rather than in storage.
    _ac = lcard.locator('label.row', has_text='images').locator('input[type=checkbox]')
    check('clipboard: the auto-copy switch is on the clipboard card itself',
          _ac.count() == 1, f'{_ac.count()} matching switches')
    if _ac.count() == 1:
        check('clipboard: it starts checked, matching the shipped default', _ac.is_checked())
        _ac.uncheck()
        lpg.wait_for_timeout(600)
        lpg.evaluate("location.hash = '#/t/settings'")
        lpg.wait_for_selector('select.ocr-select', timeout=20000)
        lpg.wait_for_timeout(400)
        _sel = lpg.locator('select.ocr-select').last
        check('clipboard: unticking it moves the preference the console actually reads',
              _sel.input_value() == 'show', f'settings select = {_sel.input_value()!r}')
        _sel.select_option('copy')
        lpg.wait_for_timeout(500)
        check('clipboard: changing it in Settings updates the open clipboard card live',
              _ac.is_checked(), f'checked={_ac.is_checked()}')
    check('clipboard: no page error on the URL and auto-copy path', not lerrs, ' | '.join(lerrs)[:200])
    lctx.close()

    # Leave the shared headless clipboard blank; later blocks do not expect content on it.
    page.evaluate("() => navigator.clipboard.writeText(' ')")

    # --- topbar geometry after the theme button was removed ---
    # The sheet sheds topbar children at 560, 470 and 360, ordered by which controls have a
    # second entry point elsewhere. The drawer toggle has none, and was shed at 380 until
    # the room link took its place, since the address bar already carries the same invite.
    # Asserted at every width rather than the one the desktop run happens to use: the bar
    # must not overflow, it must shed brand, status chip and room link in that order, the
    # drawer toggle must survive all of them, and the theme button must be gone everywhere.
    vp0 = page.viewport_size
    TB = ("() => { const t = document.querySelector('.topbar');"
          " const vis = [...t.children].filter(c => getComputedStyle(c).display !== 'none');"
          " const pad = parseFloat(getComputedStyle(t).paddingLeft) + parseFloat(getComputedStyle(t).paddingRight);"
          " const gap = parseFloat(getComputedStyle(t).columnGap) || 0;"
          " const used = vis.filter(c => !c.classList.contains('spacer'))"
          "   .reduce((s, c) => s + c.getBoundingClientRect().width, 0);"
          " return {over: t.scrollWidth > t.clientWidth + 1,"
          "  slack: Math.round(t.clientWidth - pad - used - gap * (vis.length - 1)),"
          "  theme: [...t.querySelectorAll('button')]"
          "    .filter(b => (b.title || '').includes('black and white')).length,"
          "  pins: t.querySelectorAll('button.tool-pin:not([data-tool=connect]), button.screen-share').length,"
          "  pin: vis.some(c => (c.classList.contains('tool-pin') && c.dataset.tool !== 'connect') || c.classList.contains('screen-share')),"
          "  connect: vis.some(c => c.dataset.tool === 'connect'),"
          "  brand: vis.some(c => c.classList.contains('brand')),"
          "  badge: vis.some(c => c.classList.contains('badge')),"
          "  link: vis.some(c => c.classList.contains('room-link')),"
          "  roster: vis.some(c => c.classList.contains('roster-toggle'))} }")
    # (width, brand visible, room link visible, screen button and pins visible). The status
    # chip is only asserted where a rule hides it outright; above 470 its visibility is
    # connection state, not layout. The screen button is the widest thing the bar carries, so
    # it sheds first, at the same 560 as the brand, and the slack below is measured with it
    # present.
    for w, want_brand, want_link, want_pin in ((320, False, False, False), (360, False, False, False),
                                               (390, False, True, False), (768, True, True, True)):
        page.set_viewport_size({'width': w, 'height': 720})
        page.wait_for_timeout(350)
        tb = page.evaluate(TB)
        check(f'the screen button is in the topbar DOM at {w}px', tb['pins'] >= 1, str(tb))
        check(f'the screen button and pins shed where the sheet claims at {w}px', tb['pin'] == want_pin, str(tb))
        check(f'topbar does not overflow at {w}px', not tb['over'] and tb['slack'] >= 0, str(tb))
        check(f'topbar sheds what the sheet claims at {w}px',
              tb['brand'] == want_brand and tb['link'] == want_link
              and (tb['badge'] is False or w > 470), str(tb))
        check(f'the drawer toggle is never shed, at {w}px', tb['roster'], str(tb))
        check(f'the Connect pin is never shed, at {w}px', tb['connect'], str(tb))
        check(f'no theme button on the topbar at {w}px', tb['theme'] == 0, str(tb))
    page.set_viewport_size(vp0)
    page.wait_for_timeout(300)

    # ============ store and service worker: regressions ============
    # --- store: a re-key in one tab reaches every other tab ---
    # Each tab holds the wrap key in memory while wt-keys is shared, so a tab that kept
    # writing after another tab enabled a passphrase or reset the device sealed items under
    # a key nothing could load, and the next boot showed "Boot failed" on every load. Two
    # tabs of one profile are driven through both re-keys, then an item sealed under a key
    # no tab holds is planted to stand in for a write that raced one.
    SEAL_FOREIGN = r"""async (key) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('wt-data')
        r.onupgradeneeded = () => r.result.createObjectStore('kv')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode('true')))
      await new Promise((res, rej) => {
        const tx = db.transaction('kv', 'readwrite')
        tx.objectStore('kv').put({ iv, ct }, key)
        tx.oncomplete = () => res()
        tx.onerror = () => rej(tx.error)
      })
      db.close()
      return [...ct].join(',')
    }"""
    PEEK_SEALED = r"""async (key) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('wt-data')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      const v = await new Promise((res) => {
        const rq = db.transaction('kv', 'readonly').objectStore('kv').get(key)
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res(null)
      })
      db.close()
      return v ? [...v.ct].join(',') : null
    }"""
    kx_code = 'x' + os.urandom(3).hex()
    kx_ctx = browser.new_context()
    kx_a, kx_b = kx_ctx.new_page(), kx_ctx.new_page()
    kx_errs = []
    for _pg in (kx_a, kx_b):
        _pg.on('pageerror', lambda e: kx_errs.append(str(e)))
        _pg.on('dialog', lambda d: d.accept())
        _pg.goto(f'{BASE}/#/join/{kx_code}')
        _pg.wait_for_selector('.composer', timeout=30000)

    def kx_reloaded(pg):
        try:
            pg.wait_for_function('() => window.__kxAlive === undefined', timeout=20000)
            return True
        except Exception:
            return False

    kx_b.evaluate('window.__kxAlive = 1')
    kx_a.evaluate("location.hash = '#/t/settings'")
    kx_a.wait_for_selector('input[aria-label="New vault passphrase"]', timeout=20000)
    kx_a.fill('input[aria-label="New vault passphrase"]', 'kx correct horse')
    kx_a.fill('input[aria-label="Confirm passphrase"]', 'kx correct horse')
    kx_a.locator('button', has_text='Enable passphrase lock').last.click()
    _kx_locked = kx_reloaded(kx_b)
    if _kx_locked:
        try:
            kx_b.wait_for_selector('input[aria-label="Vault passphrase"]', timeout=20000)
        except Exception:
            _kx_locked = False
    check('store: enabling a passphrase in one tab sends the other tab to the unlock screen',
          _kx_locked, kx_b.locator('#app').inner_text()[:160].replace('\n', ' / '))
    if _kx_locked:
        kx_b.fill('input[aria-label="Vault passphrase"]', 'kx correct horse')
        kx_b.locator('button', has_text='Unlock').click()
        try:
            kx_b.wait_for_selector('.composer', timeout=30000)
            _kx_open = True
        except Exception:
            _kx_open = False
        check('store: that tab opens the vault with the passphrase the first tab set',
              _kx_open, kx_b.locator('#app').inner_text()[:160].replace('\n', ' / '))

    kx_a.evaluate('window.__kxAlive = 1')
    kx_b.evaluate('window.__kxAlive = 1')
    kx_a.wait_for_selector('button:has-text("Delete everything on this device")', timeout=20000)
    kx_a.locator('button', has_text='Delete everything on this device').last.click()
    _kx_wiped = kx_reloaded(kx_a) and kx_reloaded(kx_b)
    check('store: a reset in one tab reloads the other tab too', _kx_wiped,
          kx_b.locator('#app').inner_text()[:160].replace('\n', ' / '))
    try:
        kx_b.wait_for_selector('.composer', timeout=30000)
        _kx_b_up = True
    except Exception:
        _kx_b_up = False
    check('store: after the reset the other tab boots straight into the console', _kx_b_up,
          kx_b.locator('#app').inner_text()[:160].replace('\n', ' / '))

    # The drawer toggle writes sidebar-open. Written from the tab that did not reset, it
    # has to be readable by the tab that did, so both are on the one key now on disk.
    kx_a.wait_for_selector('.composer', timeout=30000)
    if _kx_b_up:
        kx_b.locator('.roster-toggle').click()
        poll(lambda: kx_b.locator('.sidebar.open').count() == 1, 5)
        kx_b.wait_for_timeout(300)
    kx_a.reload()
    kx_a.wait_for_selector('.composer, #app pre', timeout=30000)
    check('store: the resetting tab still boots after the other tab wrote',
          kx_a.locator('.composer').count() == 1, kx_a.locator('#app').inner_text()[:200].replace('\n', ' / '))
    check('store: it reads that write, so both tabs share one key',
          kx_a.locator('.sidebar.open').count() == 1)

    kx_sealed = kx_a.evaluate(SEAL_FOREIGN, 'sidebar-open')
    kx_a.reload()
    kx_a.wait_for_selector('.composer, #app pre', timeout=30000)
    check('store: an item sealed under a key no tab holds does not stop boot',
          kx_a.locator('.composer').count() == 1, kx_a.locator('#app').inner_text()[:200].replace('\n', ' / '))
    check('store: that item reads as its default', kx_a.locator('.sidebar.open').count() == 0)
    check('store: that item is left on disk untouched', kx_a.evaluate(PEEK_SEALED, 'sidebar-open') == kx_sealed)
    check('store: no page error across the re-key paths', not kx_errs, ' | '.join(kx_errs)[:200])
    kx_ctx.close()

    # --- service worker: an update never reloads a tab out from under live media ---
    # A deployed worker activates and claims every open tab as soon as any tab of the
    # origin navigates, and the plugin's default reload ended calls and shares on the spot.
    # Registering the worker under a second script URL is the same update as a deploy:
    # workbox-window reports it as an external update and the shipped onNeedReload runs.
    # Nearby is switched off so this tab has no peer, which leaves the camera as the only
    # thing holding the reload back.
    up_ctx = browser.new_context(permissions=['microphone', 'camera'])
    up_ctx.add_init_script(VISIBILITY)
    up_pg = up_ctx.new_page()
    up_errs = []
    up_pg.on('pageerror', lambda e: up_errs.append(str(e)))
    up_pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    up_pg.wait_for_selector('.composer', timeout=30000)
    up_pg.evaluate("location.hash = '#/t/settings'")
    up_nb = up_pg.locator('label', has_text='Nearby discovery').locator('input[type=checkbox]')
    up_nb.first.wait_for(state='attached', timeout=20000)
    up_nb.first.uncheck()
    up_pg.evaluate("location.hash = ''")
    try:
        up_pg.wait_for_function("() => navigator.serviceWorker.getRegistration().then((r) => !!(r && r.active))",
                                timeout=20000)
        _up_sw = True
    except Exception:
        _up_sw = False
    check('update: the page has an active service worker to update', _up_sw)
    up_pg.locator('button[title^="Share your camera"]').click()
    try:
        up_pg.wait_for_function("() => [...document.querySelectorAll('video')].some((v) => v.srcObject"
                                " && v.srcObject.getTracks().some((t) => t.readyState === 'live'))", timeout=15000)
        _up_cam = True
    except Exception:
        _up_cam = False
    check('update: the camera is live before the update lands', _up_cam)
    up_pg.evaluate('window.__upAlive = 1')
    up_pg.evaluate("() => navigator.serviceWorker.register('/sw.js?e2e=' + Math.random().toString(36).slice(2))")
    _up_toast = poll(lambda: up_pg.locator('.toast.update-ready').count() == 1, 20)
    check('update: a tab with a live camera says an update is ready', bool(_up_toast),
          up_pg.locator('#toasts').inner_text()[:160])
    check('update: that tab keeps running instead of reloading', up_pg.evaluate('window.__upAlive') == 1)
    check('update: the notice carries a Reload button',
          up_pg.locator('.toast.update-ready button', has_text='Reload').count() == 1)
    # Absence of a reload cannot be polled for, so this waits out one pass of the 5 s check.
    up_pg.evaluate('window.__background(true)')
    up_pg.wait_for_timeout(6000)
    check('update: hiding the tab does not reload it while the camera is live',
          up_pg.evaluate('window.__upAlive') == 1)
    up_pg.evaluate('window.__background(false)')
    up_pg.locator('button[title="Stop sharing cam/mic/screen"]').click()
    try:
        up_pg.wait_for_function('() => window.__upAlive === undefined', timeout=20000)
        _up_reloaded = True
    except Exception:
        _up_reloaded = False
    check('update: once the camera stops, the idle tab reloads onto the update by itself', _up_reloaded)
    check('update: no page error on the update path', not up_errs, ' | '.join(up_errs)[:200])
    up_ctx.close()

    # --- service worker: the runtime cache follows the build ---
    # One constant cache name meant nothing was ever evicted or revalidated: public/ files
    # kept their first copy forever, the SPA fallback served for a chunk a deploy removed
    # was stored under the .js URL, and activate deleted every other cache on the origin,
    # the downloaded Whisper model included. 'wt-precache-v1' is the name every earlier
    # build used, so seeding it stands in for the cache a returning visitor still has.
    def rc_eval(pg, js, arg=None):
        try:
            return pg.evaluate(js, arg)
        except Exception:
            return None  # the page reloaded onto the update mid-call
    rc_ctx = browser.new_context()
    rc_pg = rc_ctx.new_page()
    rc_pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    rc_pg.wait_for_selector('.composer', timeout=30000)
    rc_pg.wait_for_function('() => !!navigator.serviceWorker.controller', timeout=20000)
    rc_cur = rc_pg.evaluate("""async () => {
      for (const n of await caches.keys()) if (await (await caches.open(n)).match('/index.html')) return n
      return null
    }""")
    check('cache: the precache is in a cache named after the build',
          bool(rc_cur) and rc_cur.startswith('wt-precache-') and rc_cur != 'wt-precache-v1', str(rc_cur))
    rc_pg.evaluate("""async (cur) => {
      await (await caches.open('wt-precache-v1')).put('/e2e-old-build', new Response('old'))
      await (await caches.open('transformers-cache')).put('/e2e-model', new Response('model'))
      await (await caches.open(cur)).put('/tesseract/worker-tt.js',
        new Response('// stale', { headers: { 'content-type': 'text/javascript' } }))
    }""", rc_cur or 'wt-precache-v1')
    rc_body = rc_pg.evaluate("() => fetch('/tesseract/worker-tt.js').then((r) => r.text())")
    check('cache: a public/ file comes from the network, not a stale cached copy',
          rc_body != '// stale' and len(rc_body) > 100, rc_body[:80])
    rc_gone = f'/assets/gone-{os.urandom(4).hex()}.js'
    rc_ct = rc_pg.evaluate("(u) => fetch(u).then((r) => r.headers.get('content-type'))", rc_gone)
    check('cache: a chunk the server no longer has comes back as the HTML fallback', 'text/html' in (rc_ct or ''),
          str(rc_ct))
    # The store is fire-and-forget, so a later request that is stored marks the point by
    # which the earlier one would have been.
    rc_mark = f'/icon.svg?e2e={os.urandom(3).hex()}'
    rc_pg.evaluate('(u) => fetch(u).then((r) => r.text())', rc_mark)
    check('cache: a later public/ response is stored',
          bool(poll(lambda: rc_pg.evaluate('(u) => caches.match(u).then((r) => !!r)', rc_mark), 5)))
    check('cache: that HTML is never stored under the .js URL',
          rc_pg.evaluate('(u) => caches.match(u).then((r) => !r)', rc_gone))
    rc_ctx.set_offline(True)
    rc_off = rc_eval(rc_pg, "() => fetch('/tesseract/worker-tt.js').then((r) => r.text()).catch((e) => 'ERR ' + e)")
    rc_ctx.set_offline(False)
    check('cache: offline, the public/ file still answers from the fresh copy',
          bool(rc_off) and not rc_off.startswith('ERR') and rc_off != '// stale', str(rc_off)[:80])
    rc_pg.evaluate("() => navigator.serviceWorker.register('/sw.js?e2e=' + Math.random().toString(36).slice(2))")

    def rc_pruned():
        k = rc_eval(rc_pg, '() => caches.keys()')
        return k if k is not None and 'wt-precache-v1' not in k else None
    rc_keys = poll(rc_pruned, 20) or rc_eval(rc_pg, '() => caches.keys()')
    check('cache: the next worker to activate drops the previous build cache',
          rc_keys is not None and 'wt-precache-v1' not in rc_keys, str(rc_keys))
    check('cache: it keeps the downloaded speech model', rc_keys is not None and 'transformers-cache' in rc_keys,
          str(rc_keys))
    check('cache: it keeps the current build cache', rc_keys is not None and rc_cur in rc_keys, str(rc_keys))
    rc_ctx.close()

    # A tab left open across a deploy asks for a chunk the new deployment no longer has and
    # gets index.html back. Workers are blocked here so the route answers the request the
    # way Vercel's rewrite does.
    st_ctx = browser.new_context(service_workers='block')
    st_pg = st_ctx.new_page()
    st_pg.route('**/assets/studio-*.js',
                lambda r: r.fulfill(status=200, content_type='text/html', body='<!doctype html><title>urletc</title>'))
    st_pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    st_pg.wait_for_selector('.composer', timeout=30000)
    st_pg.evaluate(f"location.hash = '#/t/{tool_id_for('studio')}'")
    st_note = poll(lambda: st_pg.locator('.toast.update-ready').count() == 1, 15)
    check('cache: a tool whose chunk is gone after a deploy offers the update', bool(st_note),
          st_pg.locator('details.card').last.inner_text()[:160].replace('\n', ' / '))
    st_ctx.close()

    # --- service worker: one online visit is enough to start offline ---
    # The entry chunk's static imports load before the worker exists on a first visit, and
    # the precache glob held only the entry itself, so an offline start failed the module
    # graph before main.ts ran and the page stayed blank. The entry's own imports are read
    # off the built file, so the check follows whatever the build splits out.
    of_ctx = browser.new_context()
    of_pg = of_ctx.new_page()
    of_pg.goto(f'{BASE}/#/join/x{os.urandom(3).hex()}')
    of_pg.wait_for_selector('.composer', timeout=30000)
    of_pg.wait_for_function('() => !!navigator.serviceWorker.controller', timeout=20000)
    of_deps = of_pg.evaluate(r"""async () => {
      const js = await (await fetch(document.querySelector('script[type=module][src]').src)).text()
      const deps = [...new Set([...js.matchAll(/from\s*"\.\/([^"]+\.js)"/g)].map((m) => '/assets/' + m[1]))]
      const cached = []
      for (const n of await caches.keys()) {
        for (const r of await (await caches.open(n)).keys()) cached.push(new URL(r.url).pathname)
      }
      return { deps, missing: deps.filter((d) => !cached.includes(d)) }
    }""")
    check('offline: the entry chunk has static imports to check', len(of_deps['deps']) > 0, str(of_deps))
    check('offline: every static import of the entry is in the worker cache', of_deps['missing'] == [],
          str(of_deps['missing']))
    of_ctx.set_offline(True)
    of_pg.evaluate('window.__ofAlive = 1')
    try:
        of_pg.goto(f'{BASE}/?e2e-offline={os.urandom(3).hex()}', timeout=20000)
        of_pg.wait_for_selector('.composer', timeout=20000)
        _of_up = of_pg.evaluate('window.__ofAlive') is None
    except Exception:
        _of_up = False
    check('offline: a fresh load with no network still opens the console', _of_up)
    of_ctx.set_offline(False)
    of_ctx.close()

    # --- service worker registers and its precache install does not reject ---
    # sw.js is a third execution context, and an unhandled rejection inside it reaches
    # neither page.on('console') nor page.on('pageerror'). That is how
    #   InvalidStateError: Cache.addAll(): duplicate requests (.../manifest.webmanifest)
    # went unseen: vite-plugin-pwa injects its generated webmanifest into the precache list
    # itself and vite.config.ts also named it in globPatterns, so the URL appeared twice,
    # addAll rejected, the install event failed and offline support was dead on every load.
    # Asserted three ways: the worker reaches "activated" (a rejected install never does,
    # so `ready` never resolves), the served list holds no duplicate URL, and addAll over
    # that exact list resolves.
    sw = page.evaluate(r"""async () => {
      if (!('serviceWorker' in navigator)) return { err: 'no serviceWorker support' }
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((r) => setTimeout(() => r(null), 20000)),
      ])
      if (!reg) return { err: 'navigator.serviceWorker.ready never resolved; install rejected' }
      const src = await (await fetch('/sw.js')).text()
      const urls = [...src.matchAll(/"url":\s*"([^"]+)"/g)].map((m) => m[1])
      let addAll = 'ok'
      try {
        const c = await caches.open('e2e-precache-probe')
        await c.addAll(urls)
      } catch (e) {
        addAll = e.name + ': ' + e.message
      } finally {
        await caches.delete('e2e-precache-probe')
      }
      return {
        state: reg.active ? reg.active.state : null,
        count: urls.length,
        dup: urls.filter((u, i) => urls.indexOf(u) !== i),
        manifest: urls.filter((u) => u.endsWith('manifest.webmanifest')).length,
        addAll,
      }
    }""")
    check('service worker reaches the activated state', sw.get('state') == 'activated', str(sw)[:200])
    check('precache list is non-empty', (sw.get('count') or 0) >= 3, str(sw.get('count')))
    check('precache list has no duplicate URL', sw.get('dup') == [], str(sw.get('dup'))[:160])
    check('precache list holds manifest.webmanifest exactly once', sw.get('manifest') == 1, str(sw.get('manifest')))
    check('precache Cache.addAll resolves (no duplicate-requests InvalidStateError)',
          sw.get('addAll') == 'ok', str(sw.get('addAll'))[:160])
    # Backstop for whichever context does surface it, since the rejection names its class.
    sw_reject = [l for l in logs
                 if 'addall' in l.lower() or 'duplicate requests' in l.lower() or 'invalidstateerror' in l.lower()]
    check('no Cache.addAll rejection anywhere in the run', not sw_reject, ' | '.join(sw_reject[:2])[:200])
    # Only favicon is dropped. Filtering relay or WebSocket lines here would let a passing
    # run coexist with a console full of red: every announce to a rate-limiting or
    # proof-of-work relay logs a line, and a relay list refusing traffic is fatal to
    # discovery.
    interesting = [l for l in logs if 'error' in l.lower() and 'favicon' not in l]
    # A Trusted Types or CSP violation means a feature is dead, so it fails the run rather
    # than scrolling past. 'trustedhtml' is matched explicitly because the sink error reads
    # "This document requires 'TrustedHTML' assignment", which matches neither
    # 'trustedscript' nor 'trusted type'.
    fatal = [l for l in interesting
             if 'trustedscript' in l.lower() or 'trustedhtml' in l.lower()
             or 'trusted type' in l.lower()
             or 'content security policy' in l.lower() or 'refused to load' in l.lower()]
    check('no Trusted Types or CSP violations in the console', not fatal, ' | '.join(fatal[:3]))

    # Rendezvous relays are third-party and do flap, and the app tolerates that, so a few
    # lines are fair. A wall of them means the relay list is refusing traffic (rate limit,
    # proof-of-work, dead host) rather than one relay having a bad minute. Counted over the
    # whole run and including warnings, since Trystero reports a refused announce through
    # console.warn while the browser reports a failed socket through console.error.
    relay_noise = [l for l in logs
                   if (l.startswith('error') or l.startswith('warning') or l.startswith('pageerror'))
                   and ('relay' in l.lower() or 'websocket' in l.lower() or 'wss://' in l.lower())]
    check(f'relay/websocket console noise stays under {RELAY_NOISE_BUDGET} lines',
          len(relay_noise) <= RELAY_NOISE_BUDGET,
          f'{len(relay_noise)} lines, e.g. ' + ' | '.join(l[:90] for l in relay_noise[:3]))

    # The relay list lives in src/p2p/session.ts but only works if connect-src allows it,
    # and drift between the two kills P2P silently, so the served CSP has to cover every
    # relay the bundle dials.
    csp = (page.evaluate("() => fetch(location.href).then(r => r.headers.get('content-security-policy') || '')")
           or '')
    missing = sorted(h for h in relay_hosts() if csp and f'wss://{h}' not in csp)
    check('every relay in the source is allowed by connect-src', not missing,
          ('CSP header absent' if not csp else 'missing: ' + ', '.join(missing)))

    # --- factory reset ("Delete everything on this device") ---
    # Last in the suite and in its own context on purpose: the main page auto-accepts every
    # dialog (see page.on('dialog') above), and accepting this one destroys the device
    # identity and vault key that every earlier block depends on.
    #
    # Both paths are driven. Dismissing must leave every store untouched; accepting must
    # take out three separate persistence layers, so all three are read back directly:
    # localStorage (the theme), IndexedDB wt-data (the OCR preference) and IndexedDB
    # wt-keys (the identity keypair, read as its exported public key so a regenerated one
    # is visibly different rather than merely present).
    IDENT = r"""async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('wt-keys')
        r.onupgradeneeded = () => r.result.createObjectStore('kv')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      if (!db.objectStoreNames.contains('kv')) { db.close(); return null }
      const pair = await new Promise((res) => {
        const rq = db.transaction('kv', 'readonly').objectStore('kv').get('identity:sign:v1')
        rq.onsuccess = () => res(rq.result)
        rq.onerror = () => res(null)
      })
      db.close()
      if (!pair || !pair.publicKey) return null
      const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
      return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('')
    }"""
    # Opened exactly the way idb-keyval opens it (no explicit version, store created in
    # onupgradeneeded) so probing or seeding cannot leave the app's own handle facing a
    # database with no 'kv' store.
    KV = r"""async ([name, put]) => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open(name)
        r.onupgradeneeded = () => r.result.createObjectStore('kv')
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
      if (!db.objectStoreNames.contains('kv')) { db.close(); return [] }
      if (put) {
        await new Promise((res, rej) => {
          const tx = db.transaction('kv', 'readwrite')
          tx.objectStore('kv').put(put[1], put[0])
          tx.oncomplete = () => res()
          tx.onerror = () => rej(tx.error)
        })
      }
      const ks = await new Promise((res) => {
        const rq = db.transaction('kv', 'readonly').objectStore('kv').getAllKeys()
        rq.onsuccess = () => res(rq.result.map(String))
        rq.onerror = () => res([])
      })
      db.close()
      return ks
    }"""

    wctx = browser.new_context(viewport={'width': 900, 'height': 900})
    wpg = wctx.new_page()
    werrs = []
    wpg.on('pageerror', lambda e: werrs.append(str(e)))
    wdlg, wmode = [], ['dismiss']
    wpg.on('dialog', lambda d: (wdlg.append(d.message), d.accept() if wmode[0] == 'accept' else d.dismiss()))
    wpg.goto(BASE)
    wpg.wait_for_selector('.composer', timeout=30000)
    wpg.evaluate("location.hash = '#/t/settings'")
    wpg.wait_for_selector('select.ocr-select', timeout=20000)
    wpg.wait_for_timeout(600)
    wcard = wpg.locator('details.card').last

    # Real writes into each layer, through the app's own controls.
    wcard.locator('select.theme-select').select_option('light')       # localStorage wt-theme
    wcard.locator('select.ocr-select').select_option('off')           # IndexedDB wt-data
    wpg.wait_for_timeout(800)
    wpg.evaluate(KV, ['wt-feeds', ['e2e-wipe-probe', {'text': 'x', 'fetchedAt': 0, 'bytes': 1}]])
    before_ident = wpg.evaluate(IDENT)
    check('wipe: setup wrote every layer the reset must reach',
          wpg.evaluate("localStorage.getItem('wt-theme')") == 'light'
          and 'image-ocr' in wpg.evaluate(KV, ['wt-data', None])
          and 'e2e-wipe-probe' in wpg.evaluate(KV, ['wt-feeds', None])
          and isinstance(before_ident, str) and len(before_ident) == 64,
          f'theme={wpg.evaluate("localStorage.getItem(\'wt-theme\')")!r} ident={before_ident!r}')

    wbtn = wcard.locator('button', has_text='Delete everything on this device')
    check('settings: the factory reset control is on the card', wbtn.count() == 1, f'{wbtn.count()} matches')
    check('settings: the factory reset control carries the danger styling',
          'danger' in (wbtn.first.get_attribute('class') or ''), wbtn.first.get_attribute('class'))

    # Dismiss path. The sentinel proves the page never reloaded, which a wipe always does.
    wpg.evaluate('window.__wtAlive = 1')
    wbtn.first.click()
    wpg.wait_for_timeout(2500)
    check('settings: the factory reset asks before doing anything', len(wdlg) == 1, str(wdlg))
    _msg = (wdlg[0] if wdlg else '').lower()
    check('settings: the confirm names what is lost',
          all(w in _msg for w in ('messages', 'identity', 'pairing', 'preferences')), _msg[:160])
    check('settings: dismissing the confirm does not reload',
          wpg.evaluate('window.__wtAlive') == 1)
    check('settings: dismissing the confirm leaves the vault intact',
          'image-ocr' in wpg.evaluate(KV, ['wt-data', None])
          and wcard.locator('select.ocr-select').input_value() == 'off')
    check('settings: dismissing the confirm leaves the identity and theme intact',
          wpg.evaluate(IDENT) == before_ident
          and wpg.evaluate("localStorage.getItem('wt-theme')") == 'light')

    # Accept path. Everything above is asserted first because this destroys the context.
    wmode[0] = 'accept'
    wbtn.first.click()
    try:
        wpg.wait_for_function('() => window.__wtAlive === undefined', timeout=20000)
        wpg.wait_for_selector('.composer', timeout=30000)
        wpg.wait_for_timeout(1200)
        _reloaded = True
    except Exception as e:
        _reloaded = False
        check('settings: accepting the confirm wipes and reloads', False, str(e)[:160])
    if _reloaded:
        check('settings: accepting the confirm wipes and reloads', True)
        check('wipe: localStorage is cleared (theme falls back to the dark default)',
              wpg.evaluate("localStorage.getItem('wt-theme')") is None
              and wpg.evaluate('document.documentElement.dataset.theme') == 'dark',
              str(wpg.evaluate("localStorage.getItem('wt-theme')")))
        check('wipe: the wt-feeds blocklist cache is cleared',
              'e2e-wipe-probe' not in wpg.evaluate(KV, ['wt-feeds', None]))
        after_ident = wpg.evaluate(IDENT)
        check('wipe: wt-keys is cleared, so the device identity is a new keypair',
              isinstance(after_ident, str) and after_ident != before_ident,
              f'{before_ident!r} -> {after_ident!r}')
        # Boot re-seeds a few wt-data keys (join code, personal secret), so the assertion is
        # that the preference written above is gone, not that the store is empty.
        wpg.evaluate("location.hash = ''")
        wpg.wait_for_timeout(300)
        wpg.evaluate("location.hash = '#/t/settings'")
        wpg.wait_for_selector('select.ocr-select', timeout=20000)
        wpg.wait_for_timeout(600)
        check('wipe: wt-data is cleared, so saved preferences are back to their defaults',
              'image-ocr' not in wpg.evaluate(KV, ['wt-data', None])
              and wpg.locator('details.card').last.locator('select.ocr-select').input_value() == 'copy')
    check('wipe: no page error on the factory reset path', not werrs, ' | '.join(werrs)[:200])
    wctx.close()

    print('\nconsole errors (filtered):', *interesting[:10], sep='\n  ')
    print(f'relay/websocket lines this run: {len(relay_noise)}')
    browser.close()

print(f'\n=== {len(passed)} passed, {len(failed)} failed ===')
for f_ in failed:
    print('FAILED:', f_)
    # Job logs need a signed-in account to read, while annotations are public through the
    # check-runs API, so on Actions each failure is also raised as one.
    if os.environ.get('GITHUB_ACTIONS'):
        print('::error title=e2e check failed::' + f_.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A'))
sys.exit(1 if failed else 0)
