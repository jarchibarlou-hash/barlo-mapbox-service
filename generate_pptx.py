#!/usr/bin/env python3
"""
BARLO — Server-side PPTX generation from diagnostic data.
Takes JSON input + template PPTX → fills text, inserts images & charts → outputs final PPTX.

Usage:
  python generate_pptx.py <input.json> <template.pptx> <output.pptx>

The input JSON must follow the /generate-pptx data contract.
"""

import json, sys, os, re, copy, tempfile, urllib.request, shutil
from pptx import Presentation
from pptx.util import Inches, Emu, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor

# Import chart generator
from generate_charts import generate_all_charts

# ═══════════════════════════════════════════════════════════════
# CONFIGURATION — placeholder → type mapping
# ═══════════════════════════════════════════════════════════════

# Placeholders that should be replaced with images (downloaded from URL)
IMAGE_PLACEHOLDERS = {
    '{{slide_4_image}}',
    '{{slide_4_axo_image}}',
    '{{scenario_A_massing}}',
    '{{scenario_B_massing}}',
    '{{scenario_C_massing}}',
}

# Placeholders that should be replaced with server-generated chart images
# These map to keys returned by generate_all_charts()
CHART_PLACEHOLDERS = {
    '{{scenario_A_risk_chart}}': ['scenario_A_risk_radar', 'scenario_A_risk_gauge', 'scenario_A_risk_bars'],
    '{{scenario_B_risk_chart}}': ['scenario_B_risk_radar', 'scenario_B_risk_gauge', 'scenario_B_risk_bars'],
    '{{scenario_C_risk_chart}}': ['scenario_C_risk_radar', 'scenario_C_risk_gauge', 'scenario_C_risk_bars'],
    '{{tableau comparative_charts}}': ['tableau_comparative_charts'],
    '{{arbitrage_graph_}}': ['arbitrage_graph_'],
}

# Placeholders for slides 17 & 18 — same key name but different content
# The JSON should provide _s17 and _s18 suffixed versions
SLIDE_SPECIFIC_TEXT = {
    # slide 17 shapes
    (17, '{{invisible_technical_text}}'): 'invisible_technical_text_s17',
    (17, '{{invisible_financial_text}}'): 'invisible_financial_text_s17',
    (17, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s17',
    # slide 18 shapes
    (18, '{{invisible_technical_text}}'): 'invisible_technical_text_s18',
    (18, '{{invisible_financial_text}}'): 'invisible_financial_text_s18',
    (18, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s18',
}


# ═══════════════════════════════════════════════════════════════
# HELPERS
# ═══════════════════════════════════════════════════════════════

def download_image(url, dest_dir):
    """Download image from URL, return local path."""
    try:
        filename = os.path.join(dest_dir, os.path.basename(url).split('?')[0] or 'image.png')
        req = urllib.request.Request(url, headers={'User-Agent': 'BARLO-PPTX/1.0'})
        with urllib.request.urlopen(req, timeout=30) as resp:
            with open(filename, 'wb') as f:
                shutil.copyfileobj(resp, f)
        return filename
    except Exception as e:
        print(f"WARNING: Failed to download {url}: {e}", file=sys.stderr)
        return None


def find_placeholder_in_shape(shape, placeholder_text):
    """Check if a shape's text contains the given placeholder."""
    if not shape.has_text_frame:
        return False
    full_text = ''.join(run.text for para in shape.text_frame.paragraphs for run in para.runs)
    # Also check paragraph-level text (some shapes have text without runs)
    if not full_text:
        full_text = shape.text_frame.text
    return placeholder_text in full_text


def get_shape_placeholder(shape):
    """Return the {{placeholder}} found in this shape, or None."""
    if not shape.has_text_frame:
        return None
    full_text = shape.text_frame.text
    # First try standard {{xxx}} pattern
    match = re.search(r'\{\{[^}]+\}\}', full_text)
    if match:
        return match.group(0)
    # Handle broken Google Slides placeholders like {{xxx}\n} (closing brace on next line)
    match = re.search(r'\{\{([a-zA-Z_][a-zA-Z0-9_ ]*)\}', full_text)
    if match:
        # Reconstruct the proper placeholder
        return '{{' + match.group(1) + '}}'
    return None


def clear_shape_text(shape):
    """Remove all text content from a shape."""
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                run.text = ''


def enable_auto_shrink(shape, min_font_size_pt=8):
    """
    Enable auto-shrink on a text shape so text automatically reduces
    font size to fit within the shape bounds.
    Sets <a:normAutofit fontScale="..." /> on the <a:bodyPr> element.
    """
    if not shape.has_text_frame:
        return
    from lxml import etree
    ns = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    txBody = shape.text_frame._txBody
    bodyPr = txBody.find(f'{{{ns}}}bodyPr')
    if bodyPr is None:
        return

    # Remove any existing autofit settings
    for child_tag in ['noAutofit', 'normAutofit', 'spAutoFit']:
        existing = bodyPr.find(f'{{{ns}}}{child_tag}')
        if existing is not None:
            bodyPr.remove(existing)

    # Add normAutofit (shrink text to fit)
    normAutofit = etree.SubElement(bodyPr, f'{{{ns}}}normAutofit')
    # fontScale in 1/1000th of a percent — min font size ratio
    # e.g., if original is 16pt and min is 8pt → 50% → 50000
    normAutofit.set('fontScale', '50000')  # allow shrink down to 50% of original size


def replace_text_in_shape(shape, placeholder, new_text):
    """
    Replace placeholder text in a shape while preserving formatting.
    For text-only placeholders, clears the instructional text and writes new content.
    """
    if not shape.has_text_frame:
        return

    tf = shape.text_frame

    # Find the paragraph containing the placeholder
    # Also handle broken placeholders (e.g. {{xxx} instead of {{xxx}})
    placeholder_found = False
    first_para_with_placeholder = None
    placeholder_core = placeholder.strip('{}')  # e.g. "conclusion_positioning_text"

    for para in tf.paragraphs:
        para_text = ''.join(run.text for run in para.runs)
        if not para_text:
            para_text = para.text
        if placeholder in para_text or ('{{' + placeholder_core) in para_text:
            placeholder_found = True
            first_para_with_placeholder = para
            break

    if not placeholder_found:
        return

    # Strategy: Keep the first paragraph's formatting, replace ALL text in the shape
    # (since the shape contains the placeholder + instructional comments we want to remove)

    # Get formatting from first run of first paragraph
    ref_run = None
    for para in tf.paragraphs:
        for run in para.runs:
            ref_run = run
            break
        if ref_run:
            break

    # Split new_text into paragraphs
    new_paragraphs = new_text.split('\n') if new_text else ['']

    # Clear all existing paragraphs except first
    xml_element = tf._txBody
    p_elements = xml_element.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}p')

    # Keep only first <a:p>, remove the rest
    for p_elem in p_elements[1:]:
        xml_element.remove(p_elem)

    # Set first paragraph text
    first_p = p_elements[0]
    # Clear existing runs in first paragraph
    r_elements = first_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
    for r_elem in r_elements:
        first_p.remove(r_elem)

    # Add new run with text
    _add_run_to_paragraph(first_p, new_paragraphs[0], ref_run)

    # Add remaining paragraphs
    for para_text in new_paragraphs[1:]:
        new_p = copy.deepcopy(first_p)
        # Clear the run text in the copy
        r_elements = new_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
        for r_elem in r_elements:
            new_p.remove(r_elem)
        _add_run_to_paragraph(new_p, para_text, ref_run)
        xml_element.append(new_p)


def _add_run_to_paragraph(p_element, text, ref_run=None):
    """Add a run element with text to a paragraph element."""
    from lxml import etree
    nsmap = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}

    r = etree.SubElement(p_element, '{http://schemas.openxmlformats.org/drawingml/2006/main}r')

    # Copy run properties from reference if available
    if ref_run is not None and ref_run._r is not None:
        rPr_orig = ref_run._r.find('{http://schemas.openxmlformats.org/drawingml/2006/main}rPr')
        if rPr_orig is not None:
            rPr = copy.deepcopy(rPr_orig)
            # Remove bold for body text (keep it clean)
            rPr.attrib.pop('b', None)
            r.insert(0, rPr)

    t = etree.SubElement(r, '{http://schemas.openxmlformats.org/drawingml/2006/main}t')
    t.text = text
    if text and (text[0] == ' ' or text[-1] == ' '):
        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')


def replace_shape_with_image(slide, shape, image_path, override_bounds=None):
    """
    Replace a text shape with an image at the same position and size.
    override_bounds: optional (left, top, width, height) in EMU to use instead of shape bounds.
    """
    if not os.path.exists(image_path):
        print(f"WARNING: Image not found: {image_path}", file=sys.stderr)
        return

    if override_bounds:
        left, top, width, height = override_bounds
    else:
        left = shape.left
        top = shape.top
        width = shape.width
        height = shape.height

    # Remove the text shape
    sp_element = shape._element
    sp_element.getparent().remove(sp_element)

    # Add image at same position
    slide.shapes.add_picture(image_path, left, top, width, height)


def replace_shape_with_multiple_images(slide, shape, image_paths):
    """
    Replace a shape with multiple images arranged horizontally within the shape's bounds.
    Used for risk chart slides (3 charts side by side).
    """
    valid_paths = [p for p in image_paths if p and os.path.exists(p)]
    if not valid_paths:
        print("WARNING: No valid images for multi-image replacement", file=sys.stderr)
        return

    left = shape.left
    top = shape.top
    total_width = shape.width
    height = shape.height
    n = len(valid_paths)

    gap = Emu(36000)  # ~1mm gap between charts
    img_width = (total_width - gap * (n - 1)) // n

    # Remove the text shape
    sp_element = shape._element
    sp_element.getparent().remove(sp_element)

    # Add images side by side
    for i, img_path in enumerate(valid_paths):
        img_left = left + i * (img_width + gap)
        slide.shapes.add_picture(img_path, img_left, top, img_width, height)


# ═══════════════════════════════════════════════════════════════
# SLIDE 15 — Special handler for comparatif table
# ═══════════════════════════════════════════════════════════════

# Shape names on slide 15 that form the empty grid (to be removed)
SLIDE_15_GRID_SHAPES = {
    'Google Shape;141;p27', 'Google Shape;145;p27',
    'Google Shape;146;p27', 'Google Shape;147;p27',
    'Google Shape;150;p27', 'Google Shape;151;p27',
    'Google Shape;152;p27', 'Google Shape;153;p27',
}

def _handle_slide_15(slide, chart_paths):
    """
    Special handling for slide 15 (comparatif stratégique).
    The template has a tiny placeholder shape + 8 empty grid shapes.
    We remove everything and insert one big comparatif chart image.
    """
    chart_path = chart_paths.get('tableau_comparative_charts')
    if not chart_path or not os.path.exists(chart_path):
        print("WARNING: No comparatif chart for slide 15", file=sys.stderr)
        return

    shapes_to_remove = []
    for shape in slide.shapes:
        name = shape.name if hasattr(shape, 'name') else ''
        placeholder = get_shape_placeholder(shape)

        # Remove the placeholder shape and all grid shapes
        if placeholder == '{{tableau comparative_charts}}' or name in SLIDE_15_GRID_SHAPES:
            shapes_to_remove.append(shape)

    for shape in shapes_to_remove:
        sp_element = shape._element
        sp_element.getparent().remove(sp_element)

    # Insert chart image using full available area (below title, above footer)
    # Title ends around y=391320, footer starts around y=4860000
    left = Emu(0)
    top = Emu(391320)
    width = Emu(9143640)   # Full slide width
    height = Emu(4400000)  # Fill down to near bottom
    slide.shapes.add_picture(chart_path, left, top, width, height)


# ═══════════════════════════════════════════════════════════════
# MAIN ASSEMBLY
# ═══════════════════════════════════════════════════════════════

def assemble_pptx(data: dict, template_path: str, output_path: str):
    """
    Main function: fills template with data, images, and charts.
    """
    # 1. Generate all charts
    chart_dir = tempfile.mkdtemp(prefix='barlo_charts_')
    print(f"Generating charts in {chart_dir}...", file=sys.stderr)
    chart_paths = generate_all_charts(data, chart_dir)
    print(f"Charts generated: {list(chart_paths.keys())}", file=sys.stderr)

    # 2. Download external images
    img_dir = tempfile.mkdtemp(prefix='barlo_images_')
    images = data.get('images', {})
    downloaded_images = {}
    for key, url in images.items():
        if url:
            print(f"Downloading image: {key}...", file=sys.stderr)
            local_path = download_image(url, img_dir)
            if local_path:
                downloaded_images[key] = local_path

    # 3. Open template
    prs = Presentation(template_path)

    # 4. Get text data
    texts = data.get('texts', {})
    client_name = data.get('client_name', '')

    # ─── TEXT KEY REMAPPING ───
    # GPT generates slide_3_intro_text + slide_3_programme_text, but template expects slide_3_text
    if 'slide_3_text' not in texts and 'slide_3_intro_text' in texts:
        parts = [texts.get('slide_3_intro_text', ''), texts.get('slide_3_programme_text', '')]
        texts['slide_3_text'] = '\n\n'.join(p for p in parts if p)

    # GPT may generate invisible_technical_text etc. without _s17/_s18 suffix
    # Map them for slides 17 and 18
    for base_key in ['invisible_technical_text', 'invisible_financial_text', 'invisible_strategic_text']:
        s17_key = f'{base_key}_s17'
        s18_key = f'{base_key}_s18'
        # If suffixed keys don't exist, try to use the base key or success_ variant
        if s17_key not in texts and base_key in texts:
            texts[s17_key] = texts[base_key]
        if s18_key not in texts:
            # For slide 18, GPT might generate success_technical_text, success_financial_text etc.
            success_key = base_key.replace('invisible_', 'success_')
            if success_key in texts:
                texts[s18_key] = texts[success_key]
            elif base_key in texts:
                texts[s18_key] = texts[base_key]

    print(f"Text keys available: {sorted(texts.keys())}", file=sys.stderr)
    print(f"Chart paths available: {sorted(chart_paths.keys())}", file=sys.stderr)

    # 5. Process each slide
    for slide_idx, slide in enumerate(prs.slides):
        slide_num = slide_idx + 1

        # ─── SLIDE 15 SPECIAL HANDLING ───
        # The comparatif placeholder shape is tiny (501480 EMU tall).
        # The slide has 8 empty grid shapes below it.
        # We remove all grid shapes and insert one big chart image.
        if slide_num == 15:
            _handle_slide_15(slide, chart_paths)
            continue

        shapes_to_process = list(slide.shapes)

        for shape in shapes_to_process:
            placeholder = get_shape_placeholder(shape)
            if not placeholder:
                continue

            placeholder_key = placeholder.strip('{}').strip()

            # ─── CLIENT NAME ───
            if placeholder == '{{client_name}}':
                replace_text_in_shape(shape, placeholder, client_name)
                continue

            # ─── EXTERNAL IMAGES ───
            if placeholder in IMAGE_PLACEHOLDERS:
                img_key = placeholder_key
                img_path = downloaded_images.get(img_key)
                if img_path:
                    replace_shape_with_image(slide, shape, img_path)
                else:
                    # Clear placeholder text but keep shape
                    clear_shape_text(shape)
                continue

            # ─── CHART IMAGES ───
            if placeholder in CHART_PLACEHOLDERS:
                chart_keys = CHART_PLACEHOLDERS[placeholder]
                chart_image_paths = [chart_paths.get(k) for k in chart_keys]
                chart_image_paths = [p for p in chart_image_paths if p]

                if len(chart_image_paths) == 1:
                    replace_shape_with_image(slide, shape, chart_image_paths[0])
                elif len(chart_image_paths) > 1:
                    replace_shape_with_multiple_images(slide, shape, chart_image_paths)
                else:
                    clear_shape_text(shape)
                continue

            # ─── SLIDE-SPECIFIC TEXT (slides 17 & 18) ───
            slide_specific_key = (slide_num, placeholder)
            if slide_specific_key in SLIDE_SPECIFIC_TEXT:
                text_key = SLIDE_SPECIFIC_TEXT[slide_specific_key]
                text = texts.get(text_key, '')
                if text:
                    replace_text_in_shape(shape, placeholder, text)
                else:
                    clear_shape_text(shape)
                continue

            # ─── REGULAR TEXT ───
            text = texts.get(placeholder_key, '')
            if text:
                replace_text_in_shape(shape, placeholder, text)
            else:
                # Try without the {{ }} in case key format differs
                clean_key = placeholder_key.replace(' ', '_')
                text = texts.get(clean_key, '')
                if text:
                    replace_text_in_shape(shape, placeholder, text)
                else:
                    print(f"WARNING: No text for placeholder {placeholder} on slide {slide_num}",
                          file=sys.stderr)

    # 5b. Insert additional charts on specific slides
    #     These are added as new shapes (not replacing existing ones)
    slides_list = list(prs.slides)

    # Slide 17: Cost breakdown pie — insert in the left column area
    cost_chart = chart_paths.get('cost_breakdown')
    if cost_chart and os.path.exists(cost_chart) and len(slides_list) >= 17:
        slide17 = slides_list[16]
        # Place below the 3 text columns, centered
        slide17.shapes.add_picture(
            cost_chart,
            Emu(2500000),   # centered-ish
            Emu(3800000),   # below the text columns
            Emu(4200000),   # width
            Emu(3400000),   # height
        )
        print("Inserted cost breakdown chart on slide 17", file=sys.stderr)

    # Slide 19: Timeline — insert below the next steps text
    timeline_chart = chart_paths.get('timeline')
    if timeline_chart and os.path.exists(timeline_chart) and len(slides_list) >= 19:
        slide19 = slides_list[18]
        slide19.shapes.add_picture(
            timeline_chart,
            Emu(200000),    # near left edge
            Emu(3200000),   # below the text
            Emu(8700000),   # almost full width
            Emu(2000000),   # height
        )
        print("Inserted timeline chart on slide 19", file=sys.stderr)

    # Slide 20: Recap card — insert below the conclusion text
    recap_chart = chart_paths.get('recap_card')
    if recap_chart and os.path.exists(recap_chart) and len(slides_list) >= 20:
        slide20 = slides_list[19]
        slide20.shapes.add_picture(
            recap_chart,
            Emu(200000),    # near left edge
            Emu(3200000),   # below the text
            Emu(8700000),   # almost full width
            Emu(1800000),   # height
        )
        print("Inserted recap card on slide 20", file=sys.stderr)

    # 6. Auto-shrink pass — enable text auto-fit on all text shapes
    #    This prevents text overflow/truncation on any slide
    shrink_count = 0
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                text_content = shape.text_frame.text.strip()
                # Only apply to shapes that have substantial text (not titles, not empty)
                if len(text_content) > 100:
                    enable_auto_shrink(shape)
                    shrink_count += 1
    print(f"Auto-shrink applied to {shrink_count} text shapes", file=sys.stderr)

    # 7. Save
    prs.save(output_path)
    print(f"PPTX saved to {output_path}", file=sys.stderr)

    # 7. Cleanup temp dirs
    shutil.rmtree(chart_dir, ignore_errors=True)
    shutil.rmtree(img_dir, ignore_errors=True)

    return output_path


# ═══════════════════════════════════════════════════════════════
# CLI
# ═══════════════════════════════════════════════════════════════
if __name__ == '__main__':
    if len(sys.argv) < 4:
        print("Usage: python generate_pptx.py <input.json> <template.pptx> <output.pptx>")
        sys.exit(1)

    input_json = sys.argv[1]
    template_pptx = sys.argv[2]
    output_pptx = sys.argv[3]

    with open(input_json, 'r', encoding='utf-8') as f:
        data = json.load(f)

    assemble_pptx(data, template_pptx, output_pptx)
    print(json.dumps({"status": "ok", "output": output_pptx}))
