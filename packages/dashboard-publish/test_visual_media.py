"""Image media and the "visual" page type.

Every case goes through the JSON adapter (gate.run), which master also has, so on master these tests fail by
behaviour (HANDOFF_SCHEMA, or no refusal), not on an unknown argument. Image bytes travel as mediaBase64, which
master ignores.
"""
import base64
import unittest

from admission import Refusal, admit, delivery, sha, validate
from gate import run
import test_admission as base
from test_admission import RAW, SHELL

PNG = b'\x89PNG\r\n\x1a\n' + b'\0' * 24
JPEG = b'\xff\xd8\xff\xe0' + b'\0' * 24
WEBP = b'RIFF\x10\0\0\0WEBPVP8 ' + b'\0' * 16
MP3 = b'ID3\x04\0\0\0\0\0\0' + b'\0' * 24
NS = b'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"'
SVG = b'<svg ' + NS + b' viewBox="0 0 4 4"><defs><linearGradient id="g"/></defs><style>@media (prefers-color-scheme:dark){rect{fill:#000}}</style>' \
      b'<rect width="4" height="4" fill="url(#g)" style="fill:url(#g)"/><use href="#g"/></svg>'
VISUAL_HEAD = b'<meta name="dashboard-id" content="fixture-1"><body data-storage-key="dbx:fixture-1">'
SHADOW = b'<script>document.body.attachShadow({mode:"open"})</script>'
VISUAL_RAW = VISUAL_HEAD + b'<img data-nl-media="assets/a.webp">'
VISUAL_SHELL = VISUAL_RAW + SHADOW


def row(name, data, kind=None):
    return {'file': 'assets/' + name, 'size': len(data), 'sha256': sha(data), **({'kind': kind} if kind else {})}


def references(rows):
    """The markup that names each row in its one allowed place."""
    return b''.join((b'<audio src="%s"></audio>' if r.get('kind', 'mp3') == 'mp3' else b'<img data-nl-media="%s">') % r['file'].encode() for r in rows)


class MediaTest(unittest.TestCase):
    setUp = base.AdmissionTest.setUp

    def gate(self, args):
        request = {'handoff': args['handoff'], 'rawBase64': base64.b64encode(args['raw']).decode(), 'shellBase64': base64.b64encode(args['shell']).decode(),
                   'dashboardId': args['dashboard_id'], 'savedKeys': args['saved_keys'], 'deliveries': args['deliveries'], 'provider': args['provider'],
                   'artifactBase64': base64.b64encode(args['artifact']).decode(), 'lock': str(args['lock']), 'ownerPid': args['owner_pid'],
                   'runtimeConfig': str(args['runtime_config']), 'mediaBase64': {k: base64.b64encode(v).decode() for k, v in (args.get('media') or {}).items()}}
        return run(request)

    def refuse(self, code, args, detail=None):
        with self.assertRaises(Refusal) as raised: self.gate(args)
        self.assertEqual(raised.exception.code, code)
        if detail: self.assertEqual(raised.exception.detail, detail)

    def with_media(self, rows, media, markup=None):
        raw = RAW.replace(b'<script>', (references(rows) if markup is None else markup) + b'<script>', 1)
        shell = raw + SHELL[len(RAW):]
        return self.args | {'handoff': self.handoff | {'mediaManifest': rows, 'sourceHtmlSha256': sha(raw)}, 'raw': raw, 'shell': shell, 'media': media,
                            'provider': self.args['provider'] | {'servedShellSha256': sha(shell)}}

    def visual(self, rows=None, markup=b'', **changes):
        rows = [row('a.webp', WEBP, 'webp')] if rows is None else rows
        raw = VISUAL_HEAD + references(rows) + markup
        handoff = {k: v for k, v in self.handoff.items() if k not in ('answerRuntimeSha256', 'answerPersistence')}
        handoff |= {'type': 'visual', 'answerKeys': [], 'sourceHtmlSha256': sha(raw), 'mediaManifest': rows}
        media = {r['file']: {'webp': WEBP, 'png': PNG, 'jpeg': JPEG, 'svg': SVG}.get(r.get('kind'), MP3) for r in rows}
        return self.args | {'handoff': handoff | changes, 'raw': raw, 'shell': raw + SHADOW, 'saved_keys': [], 'provider': {}, 'media': media}

    def test_images_of_each_kind_are_accepted_on_an_answer_page(self):
        files = {'a.webp': (WEBP, 'webp'), 'b.png': (PNG, 'png'), 'c.jpg': (JPEG, 'jpeg'), 'd.jpeg': (JPEG, 'jpeg'),
                 'e.svg': (SVG, 'svg'), 'f.mp3': (MP3, 'mp3'), 'g.mp3': (MP3, None)}
        rows = [row(name, data, kind) for name, (data, kind) in files.items()]
        result = self.gate(self.with_media(rows, {'assets/' + name: data for name, (data, _) in files.items()}))
        self.assertEqual(result['answerIdentity'], 'PASS')
        self.assertNotIn('pageType', result)

    def test_a_row_without_kind_must_be_an_mp3_name(self):
        # The one tightening of the manifest's own shape; the host refused such a file at run time already.
        self.refuse('HANDOFF_SCHEMA', self.with_media([row('a.png', PNG)], {}, markup=b''))
        self.refuse('HANDOFF_SCHEMA', self.with_media([row('a.mp3', MP3) | {'file': 'media/a.mp3'}], {}, markup=b''))

    def test_media_refusals(self):
        big = b'\x89PNG\r\n\x1a\n' + b'\0' * (2 * 1024 * 1024)
        cases = [('MEDIA_TOO_LARGE', [row('big.png', big, 'png')], {}),
                 ('MEDIA_TOO_LARGE', [row('big.svg', b' ' * (256 * 1024 + 1), 'svg')], {}),
                 ('HANDOFF_SCHEMA', [row('a.png', PNG, 'webp')], {'assets/a.png': PNG}),
                 ('HANDOFF_SCHEMA', [row('a.png', PNG, 'png') | {'file': 'media/a.png'}], {}),
                 ('MEDIA_KIND', [row('a.png', PNG, 'png')] * 2, {}),
                 ('MEDIA_COUNT', [row('i%d.png' % i, PNG, 'png') for i in range(41)], {}),
                 ('MEDIA_COUNT', [row('c%d.mp3' % i, MP3) for i in range(201)], {}),
                 ('MEDIA_BYTES', [row('a.png', PNG, 'png')], {'assets/a.png': PNG + b'x'}),
                 ('MEDIA_BYTES', [row('a.png', JPEG, 'png')], {'assets/a.png': JPEG}),
                 ('MEDIA_SVG_UNCHECKED', [row('a.svg', SVG, 'svg')], {}),
                 ('HANDOFF_SCHEMA', [row('a.gif', b'GIF89a', 'gif')], {})]
        for code, rows, media in cases:
            with self.subTest(code=code, rows=len(rows), file=rows[0]['file']): self.refuse(code, self.with_media(rows, media))

    def test_unsafe_svg_is_refused(self):
        bodies = [b'<script>alert(1)</script>', b'<rect onload="alert(1)"/>', b'<rect ONCLICK="x()"/>',
                  b'<image href="https://example.com/a.png"/>', b'<use xlink:href="other.svg#a"/>',
                  b'<rect style="fill:url(https://example.com/x)"/>', b'<rect fill="url( \'http://e.com/x\')"/>',
                  b'<style>@import "https://example.com/a.css";</style>', b'<style>rect{fill:url(http://e.com)}</style>',
                  b'<foreignObject><div/></foreignObject>', b'<a href="javascript:alert(1)"><rect/></a>',
                  # Round 1: CSS escapes and comments are refused as a mechanism, entities are decoded before the scan.
                  b'<rect style="fill:u\\72l(https://example.com/x)"/>', b'<style>rect{fill:\\75rl(http://e.com/x)}</style>',
                  b'<style>@im\\70ort "https://e.com/a.css";</style>', b'<rect style="fill:&#117;rl(https://e.com/x)"/>',
                  b'<style>rect{fill:url(/**/https://e.com/x)}</style>', b'<style>rect{fill:u/**/rl(https://e.com/x)}</style>',
                  b'<style>@font-face{font-family:x;src:url(#f)}</style>', b'<style>@namespace x url(#a);</style>']
        payloads = [b'<svg ' + NS + b'>' + body + b'</svg>' for body in bodies] + [
            b'<!DOCTYPE svg [<!ENTITY x "y">]><svg ' + NS + b'>&x;</svg>', b'<?xml-stylesheet href="https://e.com/a.css"?><svg ' + NS + b'/>',
            b'<html><script>x</script></html>', b'<svg ' + NS + b'><rect']
        for data in payloads:
            with self.subTest(payload=data[:90]):
                self.refuse('MEDIA_SVG_UNSAFE', self.with_media([row('a.svg', data, 'svg')], {'assets/a.svg': data}))

    def test_a_visual_page_needs_no_clips_answers_or_runtime(self):
        result = self.gate(self.visual())
        self.assertEqual((result['pageType'], result['answerRuntime'], result['answerIdentity']), ('visual', 'none', 'NOT_APPLICABLE'))
        self.assertEqual(result['servedShellSha256'], sha(VISUAL_RAW + SHADOW))
        self.assertEqual(self.gate(self.visual(rows=[]))['pageType'], 'visual')

    def test_a_visual_page_keeps_every_other_page_rule(self):
        self.refuse('VISUAL_ANSWERS', self.visual(answerKeys=[{'key': 'note', 'kind': 'text'}]))
        self.refuse('VISUAL_ANSWERS', self.visual(answerRuntimeSha256=sha(b'r')))
        self.refuse('VISUAL_ANSWERS', self.visual(answerPersistence='PASS'))
        self.refuse('VISUAL_ANSWERS', self.visual() | {'saved_keys': [{'key': 'note', 'kind': 'text'}]})
        self.refuse('VISUAL_ANSWERS', self.visual() | {'shell': VISUAL_SHELL + b'<script>' + SHELL + b'</script>'})
        self.refuse('VISUAL_AUDIO', self.visual(rows=[row('q.mp3', MP3, 'mp3')]))
        self.refuse('VISUAL_AUDIO', self.visual(rows=[row('q.mp3', MP3)]))
        self.refuse('SOURCE_SHA', self.visual(sourceHtmlSha256=sha(RAW)))
        self.refuse('DASHBOARD_ID', self.visual() | {'shell': VISUAL_SHELL.replace(b'dbx:fixture-1', b'dbx:other')})
        self.refuse('FIRST_IN_LINEAGE_UNAPPROVED', self.visual(design={'admission': 'FIRST_IN_LINEAGE', 'lineage': 'fixture', 'predecessorSha256': None}))
        self.refuse('LINEAGE_EXISTS', self.visual() | {'deliveries': {'fixture': [{'accepted': True}]}})
        self.refuse('ARTIFACT_TOO_LARGE', self.visual() | {'artifact': b'x' * (1048576 + 1)})
        self.refuse('DEPLOY_LOCK', self.visual() | {'owner_pid': self.args['owner_pid'] + 1})
        self.refuse('MEDIA_SVG_UNCHECKED', self.visual(rows=[row('a.svg', SVG, 'svg')]) | {'media': None})

    def test_a_visual_page_carries_no_player_frame_or_plugin_element(self):
        for tag in ('audio', 'video', 'source', 'track', 'object', 'embed', 'iframe', 'frame', 'applet'):
            with self.subTest(tag=tag): self.refuse('VISUAL_MARKUP', self.visual(markup=b'<%s src="https://example.com/x">' % tag.encode()), tag)
        self.refuse('VISUAL_MARKUP', self.visual(markup=b'<AUDIO SRC="https://example.com/a.mp3"></AUDIO>'), 'audio')
        self.refuse('VISUAL_MARKUP', self.visual(markup=b'<object data="assets/a.svg"></object>'), 'object')

    def test_a_visual_page_with_the_templates_answer_attributes_is_refused(self):
        self.refuse('VISUAL_ANSWERS', self.visual(markup=b'<textarea data-note="card-notes"></textarea>'), 'textarea')
        self.refuse('VISUAL_ANSWERS', self.visual(markup=b'<section class="df-card" data-decision="card"></section>'), 'section')
        # A form and a POST script without them are not judged here: the host refuses answers for a visual id.
        script = b'<form><input name="x"></form><script>fetch("/api/save-many",{method:"POST"})</script>'
        self.assertEqual(self.gate(self.visual(markup=script))['pageType'], 'visual')

    def test_media_is_referenced_only_in_its_one_place(self):
        svg = [row('a.svg', SVG, 'svg')]
        cases = [(self.visual(markup=b'<img src="assets/a.webp">'), 'assets/a.webp'),
                 (self.visual(markup=b'<div style="background:url(assets/a.webp)"></div>'), 'background:url(assets/a.webp)'),
                 (self.visual(markup=b'<img data-nl-media="assets/other.webp">'), 'assets/other.webp'),
                 (self.visual(markup=b'<img srcset="assets/a.webp 2x">'), 'assets/a.webp 2x'),
                 (self.with_media(svg, {'assets/a.svg': SVG}, markup=references(svg) + b'<object data="assets/a.svg"></object>'), 'assets/a.svg'),
                 (self.with_media(svg, {'assets/a.svg': SVG}, markup=b''), 'unreferenced image'),
                 (self.with_media([row('q.mp3', MP3)], {}, markup=b'<audio src="assets/q.mp3"></audio><a href="assets/q.mp3">q</a>'), 'assets/q.mp3')]
        for args, detail in cases:
            with self.subTest(detail=detail): self.refuse('MEDIA_REFERENCE', args, detail)
        served = self.with_media([row('q.mp3', MP3)], {})
        served['shell'] = served['shell'].replace(b'src="assets/q.mp3"', b'src="https://media.invalid/fixture-1/assets/q.mp3"')
        served['provider'] = served['provider'] | {'servedShellSha256': sha(served['shell'])}
        self.assertEqual(self.gate(served)['answerIdentity'], 'PASS')

    def test_any_spelling_of_a_media_path_is_held_to_its_one_place(self):
        cases = [(b'<div title="assets%2Fa.webp"></div>', 'assets%2Fa.webp'), (b'<div title="ASSETS/a.webp"></div>', 'ASSETS/a.webp'),
                 (b'<div title="assets%252Fa.webp"></div>', 'assets%252Fa.webp'), (b'<img data-nl-media="Assets/a.webp">', 'Assets/a.webp'),
                 (b'<a href="https://e.com/ASSETS%2fa.svg">x</a>', 'https://e.com/ASSETS%2fa.svg')]
        for markup, detail in cases:
            with self.subTest(detail=detail): self.refuse('MEDIA_REFERENCE', self.visual(markup=markup), detail)
        self.refuse('MEDIA_REFERENCE', self.visual(markup=b'<base href="https://example.com/">'), 'base')
        self.refuse('MEDIA_REFERENCE', self.with_media([], {}, markup=b'<base href="/elsewhere/">'), 'base')

    def test_a_served_clip_is_matched_by_its_url_path(self):
        def served(url):
            args = self.with_media([row('q.mp3', MP3)], {})
            args['shell'] = args['shell'].replace(b'src="assets/q.mp3"', b'src="' + url + b'"')
            return args | {'provider': args['provider'] | {'servedShellSha256': sha(args['shell'])}}
        self.assertEqual(self.gate(served(b'https://media.invalid/fixture-1/assets/q.mp3?v=2#t'))['answerIdentity'], 'PASS')
        for url in (b'https://media.invalid/fixture-1/assets/q.mp3.exe', b'https://media.invalid/fixture-1/assets/q.mp3/evil', b'https://media.invalid/x?f=/assets/q.mp3'):
            with self.subTest(url=url): self.refuse('MEDIA_REFERENCE', served(url))

    def test_schema_and_code_agree_except_where_only_code_can_judge(self):
        cases = [('webp row', self.with_media([row('a.webp', WEBP, 'webp')], {}), True, None),
                 ('kind and extension disagree', self.with_media([row('a.png', PNG, 'webp')], {}), False, 'HANDOFF_SCHEMA'),
                 ('no kind, image name', self.with_media([row('a.png', PNG)], {}, markup=b''), False, 'HANDOFF_SCHEMA'),
                 ('visual page with an mp3 row', self.visual(rows=[row('q.mp3', MP3, 'mp3')]), False, 'VISUAL_AUDIO'),
                 ('visual page with answer keys', self.visual(answerKeys=[{'key': 'n', 'kind': 'text'}]), False, 'VISUAL_ANSWERS'),
                 # Only code can judge these (README): sizes, counts, duplicates, bytes, the SVG scan, the markup rules.
                 ('image over its limit', self.with_media([row('a.png', b'\x89PNG\r\n\x1a\n' + b'\0' * (2 * 1024 * 1024), 'png')], {}), True, 'MEDIA_TOO_LARGE'),
                 ('duplicate file', self.with_media([row('a.png', PNG, 'png')] * 2, {}), True, 'MEDIA_KIND'),
                 ('unsafe svg', self.with_media([row('a.svg', b'<svg ' + NS + b'><script/></svg>', 'svg')], {'assets/a.svg': b'<svg ' + NS + b'><script/></svg>'}), True, 'MEDIA_SVG_UNSAFE'),
                 ('player element on a visual page', self.visual(markup=b'<video></video>'), True, 'VISUAL_MARKUP')]
        for name, args, schema_ok, code in cases:
            with self.subTest(case=name):
                try: validate(args['handoff'], 'publish-handoff', 'HANDOFF_SCHEMA'); schema = True
                except Refusal: schema = False
                self.assertEqual(schema, schema_ok)
                if code is None: self.gate(args)
                else: self.refuse(code, args)

    def test_a_visual_page_without_its_render_proof_has_no_delivery(self):
        args = self.visual()
        with self.assertRaises(Refusal) as raised:
            delivery(path=self.root / 'visual.json', handoff=args['handoff'], admission=admit(**{k: v for k, v in args.items() if k != 'media'}), shell=args['shell'],
                     artifact=b'{}', staging={'mode': 'unlisted-candidate', 'servedShellSha256': sha(args['shell'])},
                     url='https://fixture.invalid/?d=fixture-1', approved_origins=['https://fixture.invalid'],
                     existing_rows=0, runtime_config=self.runtime_config, deliveries={})
        self.assertEqual(raised.exception.code, 'PROOF_KIND')
        self.assertFalse((self.root / 'visual.json').exists())

    def test_the_json_adapter_carries_media_bytes(self):
        args = self.visual(rows=[row('a.svg', SVG, 'svg')])
        self.refuse('MEDIA_SVG_UNCHECKED', args | {'media': None})
        self.assertEqual(self.gate(args)['pageType'], 'visual')


if __name__ == '__main__':
    unittest.main()
