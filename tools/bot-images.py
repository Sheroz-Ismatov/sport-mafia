# Картинки для бота Дона: 1280×720 JPEG в client/src/img/bot/.
# Собираются из рисунков карт и шрифтов игры. Пересобрать: python3 tools/bot-images.py
import math, os, random
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = os.path.join(os.path.dirname(__file__), '..')
IMG = os.path.join(ROOT, 'client', 'src', 'img')
OUT = os.path.join(IMG, 'bot')
FONTS = os.path.join(ROOT, 'client', 'src', 'fonts')
W, H = 1280, 720

GOLD = (217, 178, 92)
GOLD_SOFT = (232, 199, 122)
RED = (240, 86, 91)
RED_SOFT = (255, 138, 142)
INK = (14, 8, 9)
TEXT = (237, 238, 240)
MUTED = (175, 165, 160)
STEEL = (139, 147, 161)

# Где на карте голова кота: центр и радиус в долях ширины/высоты карты
FACES = {
    'don': (0.51, 0.20, 0.27), 'mafia': (0.50, 0.12, 0.21), 'sheriff': (0.52, 0.15, 0.24), 'civilian': (0.55, 0.17, 0.22),
    'civilian-barber': (0.55, 0.15, 0.20), 'civilian-driver': (0.42, 0.18, 0.21), 'civilian-fisher': (0.47, 0.12, 0.21),
    'civilian-priest': (0.48, 0.17, 0.21), 'civilian-accordion': (0.47, 0.16, 0.23), 'civilian-chef': (0.47, 0.18, 0.26),
}
CIVILIANS = ['civilian', 'civilian-barber', 'civilian-driver', 'civilian-fisher', 'civilian-priest', 'civilian-accordion', 'civilian-chef']


def font(name, size, weight):
    f = ImageFont.truetype(os.path.join(FONTS, f'{name}.woff2'), size)
    f.set_variation_by_axes([weight])
    return f


def display(size, weight=800):
    return font('unbounded', size, weight)


def body(size, weight=500):
    return font('rubik', size, weight)


def art(name):
    return Image.open(os.path.join(IMG, f'{name}.webp')).convert('RGB')


def background(night=False, warm=(70, 18, 24), center=(0.5, 0.45)):
    """Тёмный фон с бордовым свечением и виньеткой."""
    base = (8, 6, 10) if night else INK
    im = Image.new('RGB', (W, H), base)
    glow = Image.new('L', (W, H), 0)
    d = ImageDraw.Draw(glow)
    cx, cy = W * center[0], H * center[1]
    for r in range(760, 0, -6):
        d.ellipse((cx - r * 1.5, cy - r, cx + r * 1.5, cy + r), fill=int(150 * (1 - r / 760) ** 1.2))
    color = (40, 14, 34) if night else warm
    im.paste(Image.new('RGB', (W, H), color), (0, 0), glow.filter(ImageFilter.GaussianBlur(50)))
    # Немного зерна, чтобы фон не был пластиковым
    rnd = random.Random(7)
    noise = Image.effect_noise((W // 2, H // 2), 18).resize((W, H)).convert('L')
    im = Image.blend(im, Image.merge('RGB', (noise, noise, noise)), 0.035)
    return im


def frame(im, color=GOLD, inset=22, width=2, radius=26):
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((inset, inset, W - inset, H - inset), radius, outline=color + (0,) if len(color) == 3 else color, width=width)
    return im


def shadow_paste(im, layer, x, y, blur=16, alpha=0.65, offset=(8, 14)):
    a = layer.split()[3].point(lambda v: int(v * alpha))
    sh = Image.new('RGBA', layer.size, (0, 0, 0, 0))
    sh.putalpha(a)
    sh = sh.filter(ImageFilter.GaussianBlur(blur))
    im.paste((0, 0, 0), (int(x + offset[0]), int(y + offset[1])), sh)
    im.paste(layer, (int(x), int(y)), layer)


def card(name, w, border=None, angle=0, radius=20):
    """Карта с рамкой цвета роли, повёрнутая на angle градусов."""
    h = int(w * 752 / 496)
    if border is None:
        border = GOLD if name == 'don' else STEEL if name == 'mafia' else (242, 181, 68) if name == 'sheriff' else RED
    pad = max(4, w // 50)
    c = Image.new('RGBA', (w + pad * 2, h + pad * 2), border + (255,))
    mask = Image.new('L', c.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, c.size[0] - 1, c.size[1] - 1), radius + pad, fill=255)
    inner = Image.new('L', (w, h), 0)
    ImageDraw.Draw(inner).rounded_rectangle((0, 0, w - 1, h - 1), radius, fill=255)
    c.paste(art(name).resize((w, h), Image.LANCZOS), (pad, pad), inner)
    c.putalpha(mask)
    return c.rotate(angle, expand=True, resample=Image.BICUBIC) if angle else c


def place(im, layer, cx, cy, **kw):
    shadow_paste(im, layer, cx - layer.size[0] / 2, cy - layer.size[1] / 2, **kw)


def head(name, d, ring=GOLD, ring_w=5, gray=False):
    """Круглый портрет кота с кольцом."""
    src = art(name)
    fx, fy, fr = FACES[name]
    sw, sh = src.size
    r = fr * sw
    box = (int(fx * sw - r), int(fy * sh - r), int(fx * sw + r), int(fy * sh + r))
    face = src.crop(box).resize((d, d), Image.LANCZOS)
    if gray:
        face = ImageOps.grayscale(face).convert('RGB')
        face = Image.blend(face, Image.new('RGB', face.size, (20, 20, 24)), 0.45)
    D = d + ring_w * 2
    out = Image.new('RGBA', (D, D), (0, 0, 0, 0))
    dr = ImageDraw.Draw(out)
    dr.ellipse((0, 0, D - 1, D - 1), fill=ring + (255,))
    m = Image.new('L', (d, d), 0)
    ImageDraw.Draw(m).ellipse((0, 0, d - 1, d - 1), fill=255)
    out.paste(face, (ring_w, ring_w), m)
    return out


def text(im, xy, s, f, fill=TEXT, anchor='la', shadow=True, spacing=8):
    d = ImageDraw.Draw(im)
    if shadow:
        sh = Image.new('RGBA', im.size, (0, 0, 0, 0))
        ImageDraw.Draw(sh).multiline_text((xy[0] + 2, xy[1] + 4), s, font=f, fill=(0, 0, 0, 200), anchor=anchor, spacing=spacing)
        im.paste(sh.filter(ImageFilter.GaussianBlur(5)), (0, 0), sh.filter(ImageFilter.GaussianBlur(5)))
    d.multiline_text(xy, s, font=f, fill=fill, anchor=anchor, spacing=spacing)


def pill(im, xy, s, f, bg=GOLD, fg=(26, 20, 6), pad=(22, 10), anchor='left'):
    d = ImageDraw.Draw(im)
    l, t, r, b = d.textbbox((0, 0), s, font=f)
    w, h = r - l + pad[0] * 2, b - t + pad[1] * 2
    x, y = xy
    if anchor == 'center':
        x -= w / 2
    d.rounded_rectangle((x, y, x + w, y + h), h / 2, fill=bg)
    d.text((x + pad[0] - l, y + pad[1] - t), s, font=f, fill=fg)
    return w, h


def step_badge(im, n):
    pill(im, (60, 52), f'{n} из 4', body(26, 700), bg=(255, 255, 255, 30) if False else (60, 30, 32), fg=GOLD_SOFT)


def save(im, name):
    os.makedirs(OUT, exist_ok=True)
    im.convert('RGB').save(os.path.join(OUT, f'{name}.jpg'), quality=84, optimize=True, progressive=True)


# ---------- Иконки, нарисованные кодом ----------

def icon_sun(im, cx, cy, r, color=GOLD_SOFT):
    d = ImageDraw.Draw(im)
    for k in range(12):
        a = k * math.pi / 6
        d.line((cx + math.cos(a) * r * 1.35, cy + math.sin(a) * r * 1.35, cx + math.cos(a) * r * 1.8, cy + math.sin(a) * r * 1.8), fill=color, width=max(3, r // 7))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=color)


def icon_moon(im, cx, cy, r, color=GOLD_SOFT, bg=(10, 7, 12)):
    glow = Image.new('L', im.size, 0)
    ImageDraw.Draw(glow).ellipse((cx - r * 2.4, cy - r * 2.4, cx + r * 2.4, cy + r * 2.4), fill=70)
    im.paste(Image.new('RGB', im.size, (90, 60, 30)), (0, 0), glow.filter(ImageFilter.GaussianBlur(r)))
    m = Image.new('L', im.size, 0)
    md = ImageDraw.Draw(m)
    md.ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
    md.ellipse((cx - r * 0.55, cy - r * 1.15, cx + r * 1.45, cy + r * 0.85), fill=0)
    im.paste(color, (0, 0), m)


def icon_clock(im, cx, cy, r, hh=9, mm=0, color=GOLD_SOFT, face=(24, 14, 16)):
    d = ImageDraw.Draw(im)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=face, outline=color, width=max(4, r // 10))
    for k in range(12):
        a = k * math.pi / 6
        r1 = r * (0.78 if k % 3 else 0.7)
        d.line((cx + math.cos(a) * r1, cy + math.sin(a) * r1, cx + math.cos(a) * r * 0.88, cy + math.sin(a) * r * 0.88), fill=color, width=max(3, r // 18))
    am = (mm / 60) * 2 * math.pi - math.pi / 2
    ah = ((hh % 12) / 12 + mm / 720) * 2 * math.pi - math.pi / 2
    d.line((cx, cy, cx + math.cos(ah) * r * 0.5, cy + math.sin(ah) * r * 0.5), fill=TEXT, width=max(6, r // 9))
    d.line((cx, cy, cx + math.cos(am) * r * 0.75, cy + math.sin(am) * r * 0.75), fill=TEXT, width=max(4, r // 14))
    d.ellipse((cx - r * 0.08, cy - r * 0.08, cx + r * 0.08, cy + r * 0.08), fill=RED)


def icon_target(im, cx, cy, r, color=RED):
    d = ImageDraw.Draw(im)
    d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=color, width=6)
    d.ellipse((cx - r * 0.45, cy - r * 0.45, cx + r * 0.45, cy + r * 0.45), outline=color, width=5)
    for a, b in [((0, -1.35), (0, -0.6)), ((0, 1.35), (0, 0.6)), ((-1.35, 0), (-0.6, 0)), ((1.35, 0), (0.6, 0))]:
        d.line((cx + a[0] * r, cy + a[1] * r, cx + b[0] * r, cy + b[1] * r), fill=color, width=6)


def icon_tile(im, x, y, w, h, big, caption, big_color=GOLD_SOFT):
    tile = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(tile).rounded_rectangle((0, 0, w - 1, h - 1), 22, fill=(30, 18, 20, 235), outline=(90, 50, 40, 255), width=2)
    shadow_paste(im, tile, x, y, blur=10, alpha=0.5)
    text(im, (x + w / 2, y + h * 0.42), big, display(54), fill=big_color, anchor='mm', shadow=False)
    text(im, (x + w / 2, y + h * 0.8), caption, body(26, 600), fill=TEXT, anchor='mm', shadow=False)


# ---------- Стол для сбора ----------

def seat_points(n=10, cx=W * 0.62, cy=H * 0.5, rx=330, ry=230):
    return [(cx + rx * math.cos(-math.pi / 2 + i * 2 * math.pi / n), cy + ry * math.sin(-math.pi / 2 + i * 2 * math.pi / n)) for i in range(n)]


def round_table(im, cx, cy, rx, ry, felt=(70, 20, 26)):
    t = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(t)
    d.ellipse((cx - rx - 14, cy - ry - 14, cx + rx + 14, cy + ry + 14), fill=(90, 58, 26, 255))
    d.ellipse((cx - rx - 6, cy - ry - 6, cx + rx + 6, cy + ry + 6), fill=GOLD + (255,))
    d.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=felt + (255,))
    shade = Image.new('L', (W, H), 0)
    ImageDraw.Draw(shade).ellipse((cx - rx * 0.8, cy - ry * 0.8, cx + rx * 0.8, cy + ry * 0.8), fill=110)
    t.paste((120, 36, 40, 255), (0, 0), shade.filter(ImageFilter.GaussianBlur(60)))
    m = Image.new('L', (W, H), 0)
    ImageDraw.Draw(m).ellipse((cx - rx - 14, cy - ry - 14, cx + rx + 14, cy + ry + 14), fill=255)
    t.putalpha(m)
    shadow_paste(im, t, 0, 0, blur=24, alpha=0.8, offset=(0, 18))


def gathering(n, status='open'):
    gray = status != 'open'
    im = background(warm=(40, 30, 30) if gray else (70, 18, 24), center=(0.6, 0.5))
    cx, cy, rx, ry = W * 0.67, H * 0.5, 225, 145
    round_table(im, cx, cy, rx, ry, felt=(40, 36, 38) if gray else (70, 20, 26))
    pts = seat_points(cx=cx, cy=cy, rx=rx + 105, ry=ry + 100)
    order = ['don', 'civilian', 'sheriff', 'civilian-chef', 'mafia', 'civilian-barber', 'civilian-accordion', 'civilian-fisher', 'civilian-driver', 'civilian-priest']
    for i, (x, y) in enumerate(pts):
        if i < n:
            hd = head(order[i], 100, ring=STEEL if gray else GOLD, ring_w=5, gray=gray)
            place(im, hd, x, y, blur=10, alpha=0.6, offset=(4, 8))
        else:
            d = ImageDraw.Draw(im)
            r = 46
            # Пустое место: пунктирный круг и плюс
            for k in range(24):
                a0 = k * 2 * math.pi / 24
                d.arc((x - r, y - r, x + r, y + r), math.degrees(a0), math.degrees(a0) + 9, fill=(120, 90, 80), width=4)
            d.line((x - 12, y, x + 12, y), fill=(120, 90, 80), width=4)
            d.line((x, y - 12, x, y + 12), fill=(120, 90, 80), width=4)
    # Счёт в центре стола
    color = MUTED if gray else (GOLD_SOFT if n >= 6 else TEXT)
    text(im, (cx, cy - 12), f'{n}/10', display(92), fill=color, anchor='mm')
    sub = 'сбор отменён' if status == 'cancelled' else 'сбор прошёл' if status == 'done' else 'стол полный' if n >= 10 else 'можно играть' if n >= 6 else f'ещё {6 - n} до старта'
    text(im, (cx, cy + 62), sub, body(30, 600), fill=GOLD_SOFT if (n >= 6 and not gray) else MUTED, anchor='mm')
    # Заголовок слева
    text(im, (70, 80), 'СБОР', body(30, 700), fill=GOLD_SOFT if not gray else MUTED)
    text(im, (70, 122), 'Садимся\nза стол', display(50), fill=TEXT if not gray else MUTED, spacing=6)
    icon_clock(im, 165, 500, 90, hh=9, mm=0, color=GOLD_SOFT if not gray else MUTED)
    frame(im, GOLD if not gray else (90, 90, 90))
    return im


# ---------- Экраны ----------

def welcome():
    im = background(center=(0.32, 0.5))
    place(im, card('civilian-accordion', 210, angle=10), 175, 400)
    place(im, card('mafia', 210, angle=-10), 545, 400)
    place(im, card('don', 270), 360, 370)
    text(im, (680, 170), 'ДОН ПРИВЕТСТВУЕТ', body(28, 700), fill=GOLD_SOFT)
    text(im, (680, 215), 'Добро\nпожаловать\nв семью', display(68), spacing=10)
    text(im, (682, 520), 'Спортивная мафия с котиками\nпрямо в Telegram', body(32, 500), fill=MUTED, spacing=10)
    frame(im)
    save(im, 'welcome')


def tour_roles():
    im = background(center=(0.5, 0.58))
    text(im, (70, 60), 'Кто есть кто', display(52))
    step_badge_right(im, 1)
    xs = [190, 420, 860, 1090]
    names = ['civilian', 'sheriff', 'mafia', 'don']
    for x, nm, a in zip(xs, names, [6, -4, 4, -6]):
        place(im, card(nm, 190, angle=a), x, 400)
    pill(im, (305, 610), 'КРАСНЫЕ', display(30, 700), bg=RED, fg=(26, 6, 7), anchor='center')
    pill(im, (975, 610), 'ЧЁРНЫЕ', display(30, 700), bg=(20, 20, 24), fg=GOLD_SOFT, anchor='center')
    text(im, (640, 400), 'против', body(34, 600), fill=MUTED, anchor='mm')
    frame(im)
    save(im, 'tour-1')


def step_badge_right(im, n):
    pill(im, (W - 70 - 150, 62), f'шаг {n} из 4', body(26, 700), bg=(60, 30, 32), fg=GOLD_SOFT)


def tour_day():
    im = background(warm=(90, 50, 20), center=(0.62, 0.5))
    text(im, (70, 60), 'День', display(64))
    text(im, (72, 150), 'Каждый говорит\nровно минуту', body(34, 500), fill=MUTED, spacing=8)
    step_badge_right(im, 2)
    icon_sun(im, 175, 450, 62)
    cx, cy, rx, ry = W * 0.64, H * 0.55, 200, 130
    round_table(im, cx, cy, rx, ry)
    pts = seat_points(cx=cx, cy=cy, rx=rx + 95, ry=ry + 85)
    order = ['civilian', 'sheriff', 'civilian-chef', 'mafia', 'civilian-barber', 'civilian-accordion', 'don', 'civilian-fisher', 'civilian-driver', 'civilian-priest']
    for i, (x, y) in enumerate(pts):
        speaking = i == 0
        hd = head(order[i], 108 if speaking else 86, ring=GOLD if speaking else (90, 60, 50), ring_w=7 if speaking else 4)
        place(im, hd, x, y, blur=8, alpha=0.6, offset=(3, 6))
    text(im, (cx, cy - 6), '1:00', display(80), fill=GOLD_SOFT, anchor='mm')
    text(im, (cx, cy + 56), 'говорит №1', body(28, 600), fill=TEXT, anchor='mm')
    frame(im)
    save(im, 'tour-2')


def tour_night():
    im = background(night=True, center=(0.6, 0.45))
    icon_moon(im, 1100, 150, 62)
    text(im, (70, 60), 'Ночь', display(64), fill=GOLD_SOFT)
    text(im, (72, 150), 'Мафия стреляет,\nдон ищет шерифа,\nшериф проверяет', body(32, 500), fill=MUTED, spacing=8)
    step_badge_right(im, 3) if False else None
    place(im, card('mafia', 190, angle=8), 560, 430)
    place(im, card('don', 220), 760, 410)
    place(im, card('sheriff', 190, angle=-8), 1010, 450)
    icon_target(im, 1010, 330, 46)
    pill(im, (70, 600), 'шаг 3 из 4', body(26, 700), bg=(60, 30, 32), fg=GOLD_SOFT)
    frame(im, (120, 100, 70))
    save(im, 'tour-3')


def tour_win():
    im = background(center=(0.5, 0.55))
    text(im, (640, 80), 'Кто победил', display(56), anchor='mm')
    step_badge_right(im, 4) if False else None
    place(im, card('sheriff', 170, angle=-6), 190, 400)
    place(im, card('civilian-chef', 170, angle=4), 390, 420)
    place(im, card('don', 190, angle=-4), 890, 410)
    place(im, card('mafia', 170, angle=6), 1090, 420)
    text(im, (640, 400), 'VS', display(110), fill=GOLD_SOFT, anchor='mm')
    pill(im, (290, 620), 'выгнать всю мафию', body(26, 700), bg=RED, fg=(26, 6, 7), anchor='center')
    pill(im, (990, 620), 'сравняться с красными', body(26, 700), bg=(20, 20, 24), fg=GOLD_SOFT, anchor='center')
    pill(im, (640, 150), 'шаг 4 из 4', body(24, 700), bg=(60, 30, 32), fg=GOLD_SOFT, anchor='center')
    frame(im)
    save(im, 'tour-4')


def played():
    im = background(center=(0.75, 0.5))
    place(im, card('sheriff', 230, angle=-6), 1080, 380)
    text(im, (70, 60), 'Спортивные правила', display(48))
    text(im, (72, 130), 'Чем отличаются от обычной мафии', body(30, 500), fill=MUTED)
    tiles = [('1:00', 'минута на речь'), ('4 фола', 'и удаление'), ('+2', 'маяк дона'), ('№№№', 'лучший ход')]
    for i, (big, cap) in enumerate(tiles):
        x = 70 + (i % 2) * 400
        y = 220 + (i // 2) * 220
        icon_tile(im, x, y, 370, 190, big, cap)
    frame(im)
    save(im, 'played')


def menu():
    im = background(center=(0.5, 0.6))
    xs = [200, 420, 640, 860, 1080]
    names = ['civilian-chef', 'sheriff', 'don', 'mafia', 'civilian-accordion']
    for i in [0, 4, 1, 3, 2]:
        place(im, card(names[i], 230 if names[i] == 'don' else 200, angle=[10, 5, 0, -5, -10][i]), xs[i], 440 + abs(i - 2) * 18)
    text(im, (640, 95), 'Семья ждёт', display(60), anchor='mm', fill=GOLD_SOFT)
    frame(im)
    save(im, 'menu')


def picker():
    im = background(center=(0.3, 0.5))
    icon_clock(im, 300, 380, 170, hh=9, mm=0)
    place(im, card('civilian-accordion', 190, angle=-8), 900, 430)
    place(im, card('civilian-chef', 190, angle=6), 1080, 450)
    text(im, (560, 120), 'Когда\nиграем?', display(66), spacing=10)
    frame(im)
    save(im, 'picker')


def reminder(kind):
    im = background(center=(0.35, 0.5))
    if kind == '60':
        icon_clock(im, 300, 360, 180, hh=8, mm=0)
        title, sub = 'Через час\nмафия', 'Проверь микрофон\nи налей себе молока'
        cats = ['civilian-barber', 'civilian-driver']
    else:
        icon_clock(im, 300, 360, 180, hh=8, mm=50)
        title, sub = 'Через 10 минут\nначинаем', 'Садись поближе\nк столу'
        cats = ['don', 'mafia']
    text(im, (560, 120), title, display(60), spacing=10)
    text(im, (562, 330), sub, body(34, 500), fill=MUTED, spacing=8)
    place(im, card(cats[0], 150, angle=-6), 960, 575)
    place(im, card(cats[1], 150, angle=6), 1120, 585)
    frame(im)
    save(im, f'remind-{kind}')


def table_open():
    im = background(center=(0.5, 0.6))
    xs = [260, 470, 640, 810, 1020]
    names = ['sheriff', 'civilian', 'don', 'mafia', 'civilian-priest']
    for i in [0, 4, 1, 3, 2]:
        place(im, card(names[i], 220 if names[i] == 'don' else 180, angle=[10, 5, 0, -5, -10][i]), xs[i], 460 + abs(i - 2) * 16)
    text(im, (640, 100), 'Стол открыт', display(64), anchor='mm', fill=GOLD_SOFT)
    text(im, (640, 170), 'садись, раздаём карты', body(32, 500), fill=MUTED, anchor='mm')
    frame(im)
    save(im, 'table-open')


def stats():
    im = background(center=(0.7, 0.5))
    place(im, card('sheriff', 260, angle=-5), 1010, 370)
    text(im, (70, 70), 'ДОСЬЕ', body(30, 700), fill=GOLD_SOFT)
    text(im, (70, 115), 'Твоя\nстатистика', display(64), spacing=10)
    for i, nm in enumerate(['civilian', 'sheriff', 'mafia', 'don']):
        place(im, card(nm, 120, angle=[-6, -2, 2, 6][i]), 140 + i * 140, 500)
    text(im, (72, 640), 'победы по каждой роли', body(28, 600), fill=MUTED)
    frame(im)
    save(im, 'stats')


def fraza(name, who, title, big):
    """Карточка фразы: сверху жанр, крупно кто говорит (или что это за история), рядом его портрет."""
    im = background(center=(0.3, 0.5))
    place(im, card(who, 250, angle=-4), 300, 380)
    text(im, (560, 80), title.upper(), body(30, 700), fill=GOLD_SOFT)
    text(im, (560, 150), '“', display(200), fill=(120, 44, 44), shadow=False)
    text(im, (560, 330), big, display(64), spacing=10)
    frame(im)
    save(im, f'fraza-{name}')


def group_hello():
    im = background(center=(0.5, 0.6))
    gathering_bg = gathering(4)
    im = gathering_bg
    save(im, 'group')


if __name__ == '__main__':
    welcome()
    tour_roles(); tour_day(); tour_night(); tour_win()
    played(); menu(); picker()
    for n in range(0, 11):
        save(gathering(n), f'gather-{n}')
    save(gathering(0, 'cancelled'), 'gather-cancelled')
    save(gathering(10, 'done'), 'gather-done')
    reminder('60'); reminder('10'); table_open(); stats()
    for name, who, title, big in [
        ('don', 'don', 'Фраза дня', 'Говорит\nДон'),
        ('mafia', 'mafia', 'Фраза дня', 'Говорит\nМафия'),
        ('sheriff', 'sheriff', 'Фраза дня', 'Говорит\nШериф'),
        ('civilian', 'civilian', 'Фраза дня', 'Говорит\nмирный'),
        ('host', 'civilian-priest', 'Фраза дня', 'Говорит\nведущий'),
        ('saying', 'civilian-fisher', 'Фраза дня', 'Сицилийская\nпоговорка'),
        ('story', 'civilian-accordion', 'Байка', 'Из жизни\nПалермо'),
        ('tip', 'don', 'Совет семьи', 'Дон\nсоветует'),
        ('log', 'sheriff', 'Из протокола', 'Записано\nв протокол'),
    ]:
        fraza(name, who, title, big)
    print('готово:', len(os.listdir(OUT)), 'картинок')
