#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Islamic Shorts Video Generator
Hook (3s) → Number+Point × 10 → merge audio
Perfect Bengali rendering via Cairo + Pango
"""
import os, sys, math, argparse, subprocess, tempfile, shutil
import cairo
import gi
gi.require_version('Pango', '1.0')
gi.require_version('PangoCairo', '1.0')
from gi.repository import Pango, PangoCairo

W, H   = 1080, 1920
FPS    = 30
GOLD   = (1.0, 0.847, 0.0, 1.0)
WHITE  = (1.0, 1.0,   1.0, 1.0)
TRANS  = (0.0, 0.0,   0.0, 0.0)
BN_NUMS = ['১','২','৩','৪','৫','৬','৭','৮','৯','১০']

# ── cairo helpers ──────────────────────────────────────────────────────────
def new_surface():
    surf = cairo.ImageSurface(cairo.FORMAT_ARGB32, W, H)
    ctx  = cairo.Context(surf)
    ctx.set_source_rgba(*TRANS)
    ctx.paint()
    return surf, ctx

def round_rect(ctx, x, y, w, h, r=24):
    ctx.new_sub_path()
    ctx.arc(x+w-r, y+r,   r, -math.pi/2, 0)
    ctx.arc(x+w-r, y+h-r, r, 0,          math.pi/2)
    ctx.arc(x+r,   y+h-r, r, math.pi/2,  math.pi)
    ctx.arc(x+r,   y+r,   r, math.pi,    3*math.pi/2)
    ctx.close_path()

def make_layout(ctx, text, px, max_w=None, align=Pango.Alignment.CENTER):
    layout = PangoCairo.create_layout(ctx)
    desc   = Pango.FontDescription()
    desc.set_family('Baloo Da 2')
    desc.set_weight(Pango.Weight.BOLD)
    desc.set_size(int(px * Pango.SCALE))
    layout.set_font_description(desc)
    layout.set_text(text, -1)
    if max_w:
        layout.set_width(int(max_w * Pango.SCALE))
        layout.set_wrap(Pango.WrapMode.WORD_CHAR)
    layout.set_alignment(align)
    return layout

def draw_text(ctx, layout, cx, cy, color):
    pw, ph = layout.get_pixel_size()
    ctx.move_to(cx - pw/2, cy - ph/2)
    ctx.set_source_rgba(*color)
    PangoCairo.show_layout(ctx, layout)
    return pw, ph

# ── frame renderers ────────────────────────────────────────────────────────
def render_hook(hook, out):
    surf, ctx = new_surface()
    max_w = W - 140
    layout = make_layout(ctx, hook, 68, max_w)
    tw, th = layout.get_pixel_size()
    pad_x, pad_y = 50, 40
    bw = tw + pad_x*2
    bh = th + pad_y*2
    bx = (W - bw) / 2
    by = (H - bh) / 2 - 60
    # box shadow
    ctx.set_source_rgba(0, 0, 0, 0.4)
    round_rect(ctx, bx+6, by+6, bw, bh, 26)
    ctx.fill()
    # box fill
    ctx.set_source_rgba(0, 0, 0, 0.72)
    round_rect(ctx, bx, by, bw, bh, 26)
    ctx.fill()
    # gold border
    ctx.set_source_rgba(*GOLD[:3], 0.5)
    ctx.set_line_width(3)
    round_rect(ctx, bx, by, bw, bh, 26)
    ctx.stroke()
    # text
    ctx.move_to(bx + pad_x, by + pad_y)
    ctx.set_source_rgba(*GOLD)
    PangoCairo.show_layout(ctx, layout)
    surf.write_to_png(out)

def render_number(num_text, out):
    surf, ctx = new_surface()
    layout = make_layout(ctx, num_text, 160)
    draw_text(ctx, layout, W/2, H*0.32, GOLD)
    surf.write_to_png(out)

def render_point(text, out):
    surf, ctx = new_surface()
    max_w = W - 120
    layout = make_layout(ctx, text, 54, max_w)
    tw, th = layout.get_pixel_size()
    pad_x, pad_y = 50, 36
    bw = max_w + pad_x*2
    bh = th + pad_y*2
    bx = (W - bw) / 2
    by = H*0.50
    ctx.set_source_rgba(0, 0, 0, 0.38)
    round_rect(ctx, bx+5, by+5, bw, bh, 22)
    ctx.fill()
    ctx.set_source_rgba(0, 0, 0, 0.72)
    round_rect(ctx, bx, by, bw, bh, 22)
    ctx.fill()
    ctx.set_source_rgba(1, 1, 1, 0.15)
    ctx.set_line_width(1.5)
    round_rect(ctx, bx, by, bw, bh, 22)
    ctx.stroke()
    ctx.move_to(bx + pad_x, by + pad_y)
    ctx.set_source_rgba(*WHITE)
    PangoCairo.show_layout(ctx, layout)
    surf.write_to_png(out)

# ── timing ─────────────────────────────────────────────────────────────────
def point_duration(text):
    words = max(1, len(text.split()))
    return max(3.0, words * 0.45 + 1.5)

def build_timeline(points):
    items = []
    t = 3.0   # hook ends at 3s
    for i, pt in enumerate(points, 1):
        num_start = t
        pt_start  = t + 1.5
        pt_end    = pt_start + point_duration(pt)
        items.append({ 'idx':i, 'pt':pt, 'num_start':num_start, 'pt_start':pt_start, 'pt_end':pt_end })
        t = pt_end
    return items, t

# ── ffmpeg filter graph ────────────────────────────────────────────────────
def build_filter(assets, total_dur):
    """
    assets: list of { path, start, end, fade_start }
    [0] = bg video
    [1] = audio (unused in video filter)
    [2..] = overlay PNGs
    """
    parts = []
    # scale + blur + dim background, loop to fill total duration
    parts.append(
        f"[0:v]loop=loop=-1:size=999999:start=0,"
        f"scale={W}:{H}:force_original_aspect_ratio=increase,"
        f"crop={W}:{H},"
        f"gblur=sigma=8,"
        f"colorchannelmixer=rr=0.45:gg=0.45:bb=0.45[base0]"
    )
    cur = 'base0'
    for idx, a in enumerate(assets, start=1):
        inp = idx + 1   # input index (0=bg, 1=audio, 2+=pngs)
        tag = f'ov{idx}'
        out = f'base{idx}'
        fade_in  = f"fade=t=in:st={a['fade_start']:.3f}:d=0.5:alpha=1"
        enable   = f"between(t,{a['start']:.3f},{a['end']:.3f})"
        parts.append(f"[{inp}:v]format=rgba,{fade_in}[{tag}]")
        parts.append(f"[{cur}][{tag}]overlay=0:0:format=auto:enable='{enable}'[{out}]")
        cur = out
    return ';'.join(parts), cur

# ── main generator ─────────────────────────────────────────────────────────
def generate(hook, points, bg_path, audio_path, font_path, out_path, tmp_dir):
    os.makedirs(tmp_dir, exist_ok=True)

    # register font
    if font_path and os.path.exists(font_path):
        font_dir = '/usr/local/share/fonts/truetype/custom'
        os.makedirs(font_dir, exist_ok=True)
        dest = os.path.join(font_dir, os.path.basename(font_path))
        if not os.path.exists(dest):
            shutil.copy2(font_path, dest)
            subprocess.run(['fc-cache','-f'], capture_output=True)

    # render PNG frames
    assets = []
    hook_png = os.path.join(tmp_dir, 'hook.png')
    render_hook(hook, hook_png)
    assets.append({ 'path':hook_png, 'start':0.0, 'end':3.0, 'fade_start':0.0 })

    timeline, total = build_timeline(points)
    print(f'[video_gen] {len(points)} points, total={total:.2f}s', flush=True)

    for item in timeline:
        num_png = os.path.join(tmp_dir, f'num_{item["idx"]}.png')
        pt_png  = os.path.join(tmp_dir, f'pt_{item["idx"]}.png')
        num_label = BN_NUMS[item['idx']-1] if item['idx'] <= 10 else str(item['idx'])
        render_number(num_label, num_png)
        render_point(item['pt'], pt_png)
        assets.append({ 'path':num_png, 'start':item['num_start'], 'end':item['pt_end'],   'fade_start':item['num_start'] })
        assets.append({ 'path':pt_png,  'start':item['pt_start'],  'end':item['pt_end'],   'fade_start':item['pt_start'] })

    filter_graph, final_label = build_filter(assets, total)

    cmd = [
        'ffmpeg', '-y',
        '-stream_loop', '-1', '-i', bg_path,     # [0] background video
        '-stream_loop', '-1', '-i', audio_path,  # [1] audio
    ]
    for a in assets:
        cmd += ['-loop', '1', '-i', a['path']]   # [2..] PNG overlays

    cmd += [
        '-filter_complex', filter_graph,
        '-map', f'[{final_label}]',
        '-map', '1:a',
        '-t', f'{total:.3f}',
        '-r', str(FPS),
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '128k',
        '-shortest',
        out_path
    ]

    print(f'[video_gen] running ffmpeg... assets={len(assets)}', flush=True)
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        print(proc.stderr[-4000:], file=sys.stderr)
        raise RuntimeError(f'FFmpeg failed (code {proc.returncode})')
    print(f'[video_gen] done → {out_path}', flush=True)

# ── CLI ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--hook',   required=True)
    ap.add_argument('--points', required=True, help='pipe-separated')
    ap.add_argument('--bg',     required=True)
    ap.add_argument('--audio',  required=True)
    ap.add_argument('--font',   default='')
    ap.add_argument('--out',    required=True)
    ap.add_argument('--tmp',    default='/tmp/yta_tmp')
    args = ap.parse_args()
    pts = [p.strip() for p in args.points.split('|') if p.strip()]
    generate(args.hook, pts, args.bg, args.audio, args.font, args.out, args.tmp)
