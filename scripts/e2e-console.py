"""E2E: utilscript console. Mount, launcher (hover/grid/reorder), generators,
TTS, collapsible cards + sidebar groups, feed deletion, code chip, theme, connect modal,
every text tool DRIVEN with real input, and the service worker precache install."""
import io
import os
import re
import sys
from playwright.sync_api import sync_playwright

# Overridable so the suite isn't pinned to one host/path (see scripts/e2e.sh, CI).
BASE = os.environ.get('E2E_BASE', 'http://localhost:5199')
SNAP = os.environ.get('E2E_SNAP', '/tmp')
passed, failed = [], []


def check(name, cond, extra=''):
    (passed if cond else failed).append(f'{name}{": " + extra if extra and not cond else ""}')
    print(('PASS' if cond else 'FAIL'), name, extra if not cond else '')


# The code room must be unique per run. With working relays a fixed literal means a
# concurrent instance of this same suite (or the developer's own browser) joins the same
# room, and the "0 peers" assertions then see real peers and fail intermittently. This is
# the non-hermetic condition section 2b warns about, closed at the source.
OWN_CODE = 'e2e' + os.urandom(3).hex()


def tool_ids():
    """Every registered tool id, read from source.

    Deliberately parsed from src/tools/index.ts rather than hardcoded, so adding a tool
    automatically puts it under test. A hardcoded list is how a tool silently stops being
    covered.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'tools', 'index.ts'), encoding='utf-8').read()
    ids = re.findall(r"^\s*id: '([a-z0-9-]+)',", src, re.M)
    assert len(ids) >= 15, f'expected the full tool registry, parsed only {ids}'
    return ids


# Third-party relays flap, so a handful of lines is tolerated. Above this the relay list
# itself is at fault (the old damus/nos.lol/nostr.band set produced about 80 in 60s, one
# per refused announce, while discovery did not work at all).
RELAY_NOISE_BUDGET = 12


def relay_hosts():
    """Relay hosts the app dials, read from src/p2p/session.ts.

    Parsed from source for the same reason tool_ids() is: a hardcoded copy is how the
    check stops covering the list it is supposed to guard.
    """
    src = io.open(os.path.join(os.path.dirname(__file__), '..', 'src', 'p2p', 'session.ts'), encoding='utf-8').read()
    decl = re.search(r'const NOSTR_RELAYS = \[(.*?)\]', src, re.S)
    assert decl, 'could not find NOSTR_RELAYS in src/p2p/session.ts'
    hosts = re.findall(r"wss://([^'\"\s]+)", decl.group(1))
    assert hosts, 'parsed no relay hosts from NOSTR_RELAYS'
    return hosts


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
    # inner_text() returns RENDERED text, so it reflects text-transform; assert the DOM
    # text and the presentation separately rather than coupling them.
    check('brand mounted', page.locator('.topbar .brand').text_content() == 'utilscript')
    check('brand uses the tracked uppercase treatment',
          page.eval_on_selector('.topbar .brand',
                                "e => getComputedStyle(e).textTransform") == 'uppercase')
    check('composer visible', page.locator('.composer textarea').is_visible())
    # The CSP sets require-trusted-types-for 'script', which makes the Worker constructor
    # a TrustedScriptURL sink. With no default policy installed EVERY worker throws, so
    # OCR, speech to text, live captions and the regex engine are all dead in production
    # while the rest of the UI looks perfectly healthy. Assert the mechanism directly.
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

    # --- 2b. hermetic runs: any OTHER utilscript behind this public IP (a stray
    # tab, another checkout) connects via Nearby and turns the "0 peers" queue
    # tests into real sends. Switch Nearby off exactly as a user would. ---
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    stn = page.locator('details.card').last
    nbl = stn.locator('label', has_text='Nearby discovery')
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
        page.wait_for_timeout(300)
        clip = page.evaluate('navigator.clipboard.readText()')
        check('code chip click copies code', clip.upper() == code_text, clip)
    except Exception as e:
        check('code chip shows auto-generated code', False, str(e)[:200])

    # --- 4. theme toggle ---
    page.locator('.topbar button[title*="black and white"]').click()
    check('theme switches to light', page.evaluate('document.documentElement.dataset.theme') == 'light')
    page.locator('.topbar button[title*="black and white"]').click()
    check('theme switches back to dark', page.evaluate('document.documentElement.dataset.theme') == 'dark')

    # --- 5. tool launcher: hover to open, grid, no scroll ---
    tools_btn = page.locator('.topbar button', has_text='Tools')
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    n_tools = page.locator('.menu.tool-grid button').count()
    check('launcher opens on hover', n_tools >= 15, f'{n_tools} tools')
    no_scroll = page.eval_on_selector('.menu.tool-grid', 'e => e.scrollHeight <= e.clientHeight + 1')
    check('launcher not scrollable', no_scroll)
    first_before = page.locator('.menu.tool-grid button').first.inner_text()
    page.screenshot(path=f'{SNAP}/e2e-launcher.png')

    # --- 6. drag-to-reorder persists ---
    src = page.locator('.menu.tool-grid button').nth(2)
    dst = page.locator('.menu.tool-grid button').nth(0)
    moved_name = src.inner_text()
    src.drag_to(dst)
    page.wait_for_timeout(400)
    first_after = page.locator('.menu.tool-grid button').first.inner_text()
    check('drag reorders tool list', first_after == moved_name and first_after != first_before, f'{first_before!r} -> {first_after!r}')
    page.keyboard.press('Escape')
    page.mouse.click(400, 300)  # close launcher
    page.wait_for_timeout(300)
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    check('reorder persists on reopen', page.locator('.menu.tool-grid button').first.inner_text() == moved_name)

    # --- 6b. Generators hover preview: values flyout beside launcher, click-to-copy ---
    page.locator('.menu.tool-grid button', has_text='Generators').hover()
    page.wait_for_selector('.gen-flyout .gen-row', timeout=6000)
    fly_rows = page.locator('.gen-flyout .gen-row').count()
    check('hover preview lists values', fly_rows >= 10, f'{fly_rows} rows')
    fv = page.locator('.gen-flyout button.gen-value').first
    fval = fv.inner_text()
    fv.click()
    page.wait_for_timeout(300)
    check('hover-preview value click copies', page.evaluate('navigator.clipboard.readText()') == fval, fval[:24])

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
    page.wait_for_timeout(300)
    check('one click copies CPF', page.evaluate('navigator.clipboard.readText()') == cpf_val)
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

    # --- 9. feed item deletion ---
    items_before = page.locator('.feed-item').count()
    wrap = page.locator('.feed-item').last
    wrap.hover()
    wrap.locator('button.del').click()
    check('feed item deletable', page.locator('.feed-item').count() == items_before - 1)

    # --- 10. text-utils auto-copy on transform ---
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text='Text Utilities').click()
    tu = page.locator('details.card').last
    tu.locator('textarea').fill('hello world')
    tu.locator('button', has_text='UPPER').click()
    page.wait_for_timeout(400)
    check('transform shows result', tu.locator('pre').inner_text() == 'HELLO WORLD')
    check('transform auto-copies', page.evaluate('navigator.clipboard.readText()') == 'HELLO WORLD')

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
    page.wait_for_timeout(300)
    check('pong has a board canvas', pong.locator('canvas.pong').count() == 1)
    lob = pong.locator('.pong-lobby')
    check('pong shows the opponent lobby', lob.count() == 1 and 'opponent' in lob.inner_text().lower(), (lob.inner_text()[:60] if lob.count() else 'no lobby'))

    # --- 11f. html-strip: real HTML in, plain text out ---
    # Mounting a tool is not exercising it. html-strip mounted cleanly and passed every
    # run while being completely broken in production: DOMParser.parseFromString is a
    # TrustedHTML sink, so stripHtml() threw under require-trusted-types-for and the
    # button did nothing. Nothing here had ever clicked it. This is that click.
    tools_btn.hover()
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    page.locator('.menu.tool-grid button', has_text=re.compile('HTML')).first.click()
    hs = page.locator('details.card').last
    hs_before = len(logs)
    # The script and style payloads are here on purpose: textContent includes the SOURCE of
    # those elements, so a naive implementation strips this to "...hereSNEAKYCSSLEAK".
    hs.locator('textarea').fill(
        '<div><h1>Title</h1><p>Body <b>text</b> here.</p>'
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
    # The sink error reads "This document requires 'TrustedHTML' assignment", which matches
    # neither 'trustedscript' nor 'trusted type', so the run-wide filters below were blind
    # to it. Assert the exact string class at the call site as well.
    hs_tt = [l for l in logs[hs_before:] if 'trustedhtml' in l.lower()]
    check('html-strip: no TrustedHTML sink violation on strip', not hs_tt, ' | '.join(hs_tt[:2])[:200])

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

    # user-defined code: mixed case + punctuation normalizes to [a-z0-9].
    # Derived from OWN_CODE so the room stays unique per run while still exercising
    # normalization (upper case, a dash and a trailing bang all have to be stripped).
    page.locator('.modal input.mono-input').fill(f'{OWN_CODE[:3].upper()}-{OWN_CODE[3:].upper()}!')
    page.locator('.modal button', has_text=re.compile(r'^Join$')).click()
    page.wait_for_timeout(1200)
    custom = page.locator('.modal .code-big').inner_text().strip().lower()
    check('user can define own code', custom == OWN_CODE, custom)
    check('chip shows custom code', page.locator('button.code-chip').inner_text().strip().lower() == OWN_CODE)
    page.screenshot(path=f'{SNAP}/e2e-connect.png')
    page.keyboard.press('Escape')
    page.mouse.click(10, 300)

    # --- 13b. the chosen code survives a full reload ---
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
    check('default name is peer-N (no "me")', re.fullmatch(r'peer-\d+', nm.input_value() or '') is not None, nm.input_value())
    check('no corny copy in modal', 'keep it secret' not in page.locator('.modal').inner_text().lower())
    page.keyboard.press('Escape')
    page.wait_for_timeout(200)

    # --- 13e. offline queue: sending with no peers keeps + queues the message ---
    me_before = page.locator('.msg.me').count()
    page.locator('.composer textarea').fill('queued hello')
    page.locator('.composer textarea').press('Enter')
    page.wait_for_timeout(300)
    check('own bubble rendered with 0 peers', page.locator('.msg.me').count() == me_before + 1)
    check('queued toast shown', page.locator('.toast', has_text='queued').count() >= 1)
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
    page.locator('.composer textarea').click()  # composer focus must NOT block image paste
    cards_before = page.locator('.feed-item').count()
    page.evaluate('''async () => {
      // A real rendered-text PNG, not a bare signature: a fake image fails libpng
      // before OCR ever runs, which is how the OCR outage stayed invisible here.
      const c = document.createElement('canvas'); c.width = 520; c.height = 140
      const g = c.getContext('2d')
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
      g.fillStyle = '#000'; g.font = 'bold 76px Georgia, serif'; g.textBaseline = 'middle'
      g.fillText('Hello utilscript', 18, 74)
      const blob = await new Promise(r => c.toBlob(r, 'image/png'))
      const dt = new DataTransfer()
      dt.items.add(new File([blob], 'shot.png', { type: 'image/png' }))
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }''')
    page.wait_for_timeout(500)
    check('image paste creates a card', page.locator('.feed-item').count() == cards_before + 1)
    last_card = page.locator('.feed-item').last
    check('image card has preview', last_card.locator('img.preview').count() == 1)
    sendbtn = last_card.locator('button', has_text='Send to devices')
    check('send button present with 0 peers', sendbtn.count() == 1)
    sendbtn.click()
    page.wait_for_timeout(300)
    check('send with 0 peers toasts gracefully', page.locator('.toast', has_text='No one connected').count() >= 1)
    # Proactive OCR, default "copy": no manual button, the output area is revealed at once.
    pre = last_card.locator('pre')
    check('proactive OCR replaces manual button', last_card.locator('button', has_text='Run OCR').count() == 0)
    check('proactive OCR output area revealed', pre.count() == 1 and 'hidden' not in (pre.get_attribute('class') or ''))
    # The pasted image contains real rendered text, so this asserts the WHOLE OCR pipeline:
    # worker construction under Trusted Types, WASM core load, and recognition output.
    # Anything less than reading the text back is how a dead OCR passed as green before.
    # The same <pre> shows progress ("Reading...", "Recognizing... 62%") before the result,
    # so waiting for "non-empty" would capture a progress string. Wait for text that is not
    # a progress line. Fetching language data makes this slower against a live deployment
    # than against a local preview, hence the generous budget.
    ocr_text = ''
    for _ in range(45):
        page.wait_for_timeout(1000)
        t_ = (pre.inner_text() or '').strip()
        if t_ and '%' not in t_ and not t_.lower().startswith(('reading', 'recognizing', 'loading', 'initial')):
            ocr_text = t_
            break
        ocr_text = t_
    check('OCR worker starts under Trusted Types',
          'TrustedScriptURL' not in ocr_text and 'Failed to construct' not in ocr_text, ocr_text[:160])
    check('OCR actually reads the pasted image', 'utilscript' in ocr_text.lower(), ocr_text[:160])

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
    page.wait_for_timeout(300)
    invite = page.evaluate('navigator.clipboard.readText()')
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

    # --- 13j. composer: typing a join code connects ---
    # The placeholder deliberately does NOT explain join codes. A placeholder names the
    # field; the 🔗 share button in the topbar is the discovery path. Assert the behaviour
    # and that the placeholder stayed short, rather than pinning the old teaching copy.
    ph = page.locator('.composer textarea').get_attribute('placeholder') or ''
    check('placeholder names the field without a lecture', 0 < len(ph) <= 48 and 'join code' not in ph, ph)
    page.locator('.composer textarea').fill('q7x2k9')
    page.locator('.composer textarea').press('Enter')
    try:
        page.wait_for_function(
            "() => (document.querySelector('button.code-chip')?.textContent || '').trim() === 'Q7X2K9'",
            timeout=20000)
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
    # dismissable. The control is wired even while the strip is hidden (opt-in gates the
    # Whisper worker, which headless can't run).
    check('captions have a minimize (collapse) control', page.locator('.captions button[title*="Minimize"]').count() == 1)
    check('captions have a separate off control', page.locator('.captions button[title*="Turn captions off"]').count() == 1)
    page.locator('.composer .bar button[title*="Stop sharing"]').click()
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
    page.locator('.composer .bar button[title*="Stop sharing"]').click()
    page.wait_for_timeout(300)
    check('stopping share hides the tiles region again', not page.locator('.tiles-region').is_visible())

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
    check('settings: OCR default is auto-copy', st.locator('select').input_value() == 'copy', st.locator('select').input_value())
    check('settings: captions toggle present', st.locator('input[type=checkbox]').count() >= 1)
    # The presence ("online list") tier announces you to every other user, so unlike
    # nearby it must be opt-in and start OFF, and it must never carry traffic.
    pr = st.locator('label', has_text='Online list').locator('input[type=checkbox]')
    check('settings: online-list toggle present', pr.count() == 1)
    check('settings: online list is opt-in (off by default)', not pr.is_checked())
    check('settings: online list is described as presence-only',
          'no messages, files or media' in st.locator('label', has_text='Online list').inner_text().lower())
    check('roster shows no online-list group while opted out',
          page.locator('.pgroup summary', has_text='Online now').count() == 0)
    st.locator('select').select_option('off')
    page.wait_for_timeout(300)
    page.evaluate("location.hash = '#/t/base64'")
    page.wait_for_timeout(300)
    page.evaluate("location.hash = '#/t/settings'")
    page.wait_for_timeout(800)
    st2 = page.locator('details.card').last
    check('settings: OCR mode persists', st2.locator('select').input_value() == 'off')
    st2.locator('select').select_option('copy')  # restore the default for reruns
    page.wait_for_timeout(200)

    # --- 13n. Studio (VDO.ninja-style A/V): publish controls, labeled source, layouts, stage link ---
    page.evaluate("location.hash = '#/t/studio'")
    page.wait_for_timeout(500)
    studio = page.locator('details.card').last
    check('studio renders publish controls', studio.locator('button', has_text='Publish camera').count() == 1)
    check('studio has camera + mic + res selects', studio.locator('select').count() == 3)
    check('studio has grid/spotlight/solo layout switch',
          studio.locator('button', has_text=re.compile(r'^(Grid|Spotlight|Solo)$')).count() == 3)
    # publish the fake camera, so a labeled stage tile and a source-list entry appear
    studio.locator('button', has_text='Publish camera').click()
    try:
        page.wait_for_selector('.tiles.stage .stage-tile', timeout=10000)
        check('publishing camera creates a stage tile', page.locator('.stage-tile').count() >= 1)
        check('stage tile has a nameplate', page.locator('.stage-tile .tile-name').count() >= 1)
        check('source appears in the studio list', studio.locator('.src-name').count() >= 1)
        # switch layout, so the stage container reflects it and a tile is spotlighted
        studio.locator('button', has_text=re.compile(r'^Spotlight$')).click()
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
        page.wait_for_timeout(300)
        clip = page.evaluate('navigator.clipboard.readText()')
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

    # --- 14. slash filter opens launcher ---
    page.locator('.composer textarea').fill('/json')
    page.locator('.composer textarea').press('Enter')
    page.wait_for_selector('.menu.tool-grid', timeout=3000)
    names = page.eval_on_selector_all('.menu.tool-grid button', 'els => els.map(e => e.textContent)')
    check('slash filter narrows tools', len(names) >= 1 and all('JSON' in n for n in names), str(names))
    page.mouse.click(400, 300)

    # --- 15. tool deep-link (#/t/<id>) opens the tool ---
    page.evaluate("location.hash = '#/t/base64'")
    page.wait_for_timeout(500)
    check('deep-link #/t/base64 opens the tool', page.locator('details.card summary', has_text='Base64').count() >= 1)

    # window.scrollY is ALWAYS 0 here because .app-shell is overflow:hidden, so the old
    # assertion proved nothing: the composer could be squeezed to its padding and pushed
    # under the viewport edge while this still passed. Two real bugs hid behind it at
    # once. .composer-wrap carries overflow:hidden to reserve the scrollbar gutter, and a
    # grid item only gets an automatic min-content floor while overflow is visible, so the
    # row collapsed to 24px against the 122px it needed. Separately .center placed its rows
    # positionally while the stage and captions are display:none when idle, so the feed slid
    # onto the auto row and grew to full content height. Assert the geometry instead.
    # The row-shift half of the bug only appears with an IDLE stage, because .tiles-region
    # and .captions are display:none then and the remaining children slide up a row. Late in
    # this run the stage still holds tiles, which accidentally restores the correct order, so
    # the precondition has to be forced rather than assumed.
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
    page.locator('.topbar button[title*="black and white"]').click()
    page.screenshot(path=f'{SNAP}/e2e-final-light.png', full_page=False)

    # --- every registered tool must mount without crashing or violating the CSP ---
    # OCR shipped completely broken because nothing in this suite ever opened it: the
    # Worker constructor was blocked by Trusted Types, four features were dead, and the
    # run stayed green. Opening every tool means a whole tool cannot go dark unnoticed.
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

    # --- every pure text tool is DRIVEN, not just mounted ---
    # Mounting proves the module imports. It proves nothing about the tool working: the
    # loop above passed on html-strip for as long as html-strip has been broken. Each tool
    # with an obvious input and output gets a known input, a real trigger, and an assertion
    # that something non-empty and non-error came back.
    # (id, [(selector, nth, value)], trigger button text or None, output selector, reject substrings)
    SMOKE = [
        ('base64', [('textarea', 0, 'utilscript')], 'Encode', 'pre', ('error', 'invalid')),
        ('hash', [('textarea', 0, 'abc')], 'Hash text', 'pre', ('failed', 'hex digest')),
        ('json-format', [('textarea', 0, '{"b":1,"a":[2,3]}')], 'Format', 'pre', ('invalid json',)),
        ('url-info', [('input.full', 0, 'https://example.com:8080/p?q=1#h')], 'Parse', '.stack', ('not a valid url',)),
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

    # Heavy features build a Worker. Assert each kind can actually be constructed under
    # the live CSP, rather than trusting that the UI rendered.
    check('OCR worker shim is reachable and parses',
          page.evaluate("async () => { const r = await fetch('/tesseract/worker-tt.js');"
                        " return r.ok && (await r.text()).includes('createPolicy') }"))

    # --- service worker registers and its precache install does not reject ---
    # sw.js is a THIRD execution context: an unhandled rejection inside it reaches neither
    # page.on('console') nor page.on('pageerror'), which is exactly how
    #   InvalidStateError: Cache.addAll(): duplicate requests (.../manifest.webmanifest)
    # shipped unseen. vite-plugin-pwa injects its generated webmanifest into the precache
    # list by itself, and vite.config.ts named it in globPatterns too, so the same URL was
    # in the list twice, addAll rejected, the whole install event failed and offline
    # support was dead on every load. Asserted three ways: the worker actually reaches
    # "activated" (a rejected install never gets there, so `ready` never resolves), the
    # served list has no duplicate URL, and addAll over that exact list resolves.
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
    # Belt and braces for whichever context does surface it: the rejection names its class.
    sw_reject = [l for l in logs
                 if 'addall' in l.lower() or 'duplicate requests' in l.lower() or 'invalidstateerror' in l.lower()]
    check('no Cache.addAll rejection anywhere in the run', not sw_reject, ' | '.join(sw_reject[:2])[:200])
    # Only favicon is dropped. Relay/WebSocket lines used to be filtered out here, which
    # is how a green suite coexisted with a devtools console full of red: every announce
    # to a rate-limiting or proof-of-work relay logs a line, so a broken relay list was
    # invisible to the suite AND meant discovery did not work at all.
    interesting = [l for l in logs if 'error' in l.lower() and 'favicon' not in l]
    # A Trusted Types or CSP violation means a real feature is dead, so it fails the run
    # instead of scrolling past.
    # 'trustedhtml' is listed explicitly: the sink error reads "This document requires
    # 'TrustedHTML' assignment", which matches neither 'trustedscript' nor 'trusted type',
    # so a dead HTML sink used to slip past this filter entirely.
    fatal = [l for l in interesting
             if 'trustedscript' in l.lower() or 'trustedhtml' in l.lower()
             or 'trusted type' in l.lower()
             or 'content security policy' in l.lower() or 'refused to load' in l.lower()]
    check('no Trusted Types or CSP violations in the console', not fatal, ' | '.join(fatal[:3]))

    # Rendezvous relays are third-party and genuinely flap, and the app is built to
    # tolerate that, so a few lines are fair. A wall of them is not: it means the relay
    # list is refusing traffic (rate limit, proof-of-work, dead host) rather than one
    # relay having a bad minute. Counted over the whole run, warnings included, because
    # Trystero reports a refused announce via console.warn and the browser reports a
    # failed socket via console.error.
    relay_noise = [l for l in logs
                   if (l.startswith('error') or l.startswith('warning') or l.startswith('pageerror'))
                   and ('relay' in l.lower() or 'websocket' in l.lower() or 'wss://' in l.lower())]
    check(f'relay/websocket console noise stays under {RELAY_NOISE_BUDGET} lines',
          len(relay_noise) <= RELAY_NOISE_BUDGET,
          f'{len(relay_noise)} lines, e.g. ' + ' | '.join(l[:90] for l in relay_noise[:3]))

    # The relay list lives in src/p2p/session.ts but only works if connect-src allows it.
    # Drift between the two silently kills P2P, so assert the served CSP covers every
    # relay the shipped bundle actually dials.
    csp = (page.evaluate("() => fetch(location.href).then(r => r.headers.get('content-security-policy') || '')")
           or '')
    missing = sorted(h for h in relay_hosts() if csp and f'wss://{h}' not in csp)
    check('every relay in the source is allowed by connect-src', not missing,
          ('CSP header absent' if not csp else 'missing: ' + ', '.join(missing)))

    print('\nconsole errors (filtered):', *interesting[:10], sep='\n  ')
    print(f'relay/websocket lines this run: {len(relay_noise)}')
    browser.close()

print(f'\n=== {len(passed)} passed, {len(failed)} failed ===')
for f_ in failed:
    print('FAILED:', f_)
sys.exit(1 if failed else 0)
