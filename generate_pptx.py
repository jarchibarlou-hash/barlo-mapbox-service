#!/usr/bin/env python3
"""
BARLO — Server-side PPTX generation from diagnostic data.
"""
import json, sys, os, re, copy, tempfile, urllib.request, shutil
from pptx import Presentation
from pptx.util import Inches, Emu, Pt
from pptx.enum.text import PP_ALIGN
from pptx.dml.color import RGBColor
from generate_charts import generate_all_charts

IMAGE_PLACEHOLDERS = {
    '{{slide_4_image}}',
    '{{slide_4_axo_image}}',
    '{{scenario_A_massing}}',
    '{{scenario_B_massing}}',
    '{{scenario_C_massing}}',
}

CHART_PLACEHOLDERS = {
    '{{scenario_A_risk_chart}}': ['scenario_A_risk_radar', 'scenario_A_risk_gauge', 'scenario_A_risk_bars'],
    '{{scenario_B_risk_chart}}': ['scenario_B_risk_radar', 'scenario_B_risk_gauge', 'scenario_B_risk_bars'],
    '{{scenario_C_risk_chart}}': ['scenario_C_risk_radar', 'scenario_C_risk_gauge', 'scenario_C_risk_bars'],
    '{{tableau comparative_charts}}': ['tableau_comparative_charts'],
    '{{arbitrage_graph_}}': ['arbitrage_graph_', 'arbitrage_graph_costs'],
}

SLIDE_SPECIFIC_TEXT = {
    (17, '{{invisible_technical_text}}'): 'invisible_technical_text_s17',
    (17, '{{invisible_financial_text}}'): 'invisible_financial_text_s17',
    (17, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s17',
    (18, '{{invisible_technical_text}}'): 'invisible_technical_text_s18',
    (18, '{{invisible_financial_text}}'): 'invisible_financial_text_s18',
    (18, '{{invisible_strategic_text}}'): 'invisible_strategic_text_s18',
}

# Risk chart slides that need fallback shape detection
RISK_CHART_SLIDES = {8, 11, 14}

def download_image(url, dest_dir):
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
    if not shape.has_text_frame:
        return False
    full_text = ''.join(run.text for para in shape.text_frame.paragraphs for run in para.runs)
    if not full_text:
        full_text = shape.text_frame.text
    return placeholder_text in full_text

def get_shape_placeholder(shape):
    if not shape.has_text_frame:
        return None
    full_text = shape.text_frame.text
    match = re.search(r'\{\{[^}]+\}\}', full_text)
    if match:
        return match.group(0)
    match = re.search(r'\{\{([a-zA-Z_][a-zA-Z0-9_ ]*)\}', full_text)
    if match:
        return '{{' + match.group(1) + '}}'
    return None

def clear_shape_text(shape):
    if shape.has_text_frame:
        for para in shape.text_frame.paragraphs:
            for run in para.runs:
                run.text = ''

def get_font_size_for_slide(slide_num):
    """
    Return the target font size (in points) for a given slide.
    Applies after text replacement.
    """
    if slide_num == 15:
        return None  # Slide 15 is handled specially
    elif slide_num in [8, 11, 14]:
        # Risk text below charts
        return Pt(11)
    elif slide_num in [17, 18]:
        # 3-column layout
        if slide_num == 18:
            # Exclude right column (phasage) from auto-sizing
            return None
        return Pt(11)
    elif slide_num in [19, 20]:
        return Pt(11)
    elif slide_num in [3, 4, 5, 6, 9, 12]:
        # Scenario slides
        return Pt(12)
    elif slide_num in [7, 10, 13]:
        # Financial slides
        return Pt(12)
    else:
        return Pt(11)

def set_font_size_for_shape(shape, font_size_pt):
    """
    Set all text runs in a shape to a specific font size.
    """
    if not shape.has_text_frame or font_size_pt is None:
        return
    for para in shape.text_frame.paragraphs:
        for run in para.runs:
            run.font.size = font_size_pt

def enable_auto_shrink(shape, min_font_size_pt=8, fontScale=62500):
    """
    Enable auto-shrink for text overflow.
    fontScale: 62500 = 62.5% minimum size (15pt → minimum 9.4pt)
    """
    if not shape.has_text_frame:
        return
    from lxml import etree
    ns = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    txBody = shape.text_frame._txBody
    bodyPr = txBody.find(f'{{{ns}}}bodyPr')
    if bodyPr is None:
        return
    for child_tag in ['noAutofit', 'normAutofit', 'spAutoFit']:
        existing = bodyPr.find(f'{{{ns}}}{child_tag}')
        if existing is not None:
            bodyPr.remove(existing)
    normAutofit = etree.SubElement(bodyPr, f'{{{ns}}}normAutofit')
    normAutofit.set('fontScale', str(fontScale))

def replace_text_in_shape(shape, placeholder, new_text):
    if not shape.has_text_frame:
        return
    tf = shape.text_frame
    placeholder_found = False
    first_para_with_placeholder = None
    placeholder_core = placeholder.strip('{}')
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
    ref_run = None
    for para in tf.paragraphs:
        for run in para.runs:
            ref_run = run
            break
        if ref_run:
            break
    new_paragraphs = new_text.split('\n') if new_text else ['']
    xml_element = tf._txBody
    p_elements = xml_element.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}p')
    for p_elem in p_elements[1:]:
        xml_element.remove(p_elem)
    first_p = p_elements[0]
    r_elements = first_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
    for r_elem in r_elements:
        first_p.remove(r_elem)
    _add_run_to_paragraph(first_p, new_paragraphs[0], ref_run)
    for para_text in new_paragraphs[1:]:
        new_p = copy.deepcopy(first_p)
        r_elements = new_p.findall('{http://schemas.openxmlformats.org/drawingml/2006/main}r')
        for r_elem in r_elements:
            new_p.remove(r_elem)
        _add_run_to_paragraph(new_p, para_text, ref_run)
        xml_element.append(new_p)

def _add_run_to_paragraph(p_element, text, ref_run=None):
    from lxml import etree
    nsmap = {'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'}
    r = etree.SubElement(p_element, '{http://schemas.openxmlformats.org/drawingml/2006/main}r')
    if ref_run is not None and ref_run._r is not None:
        rPr_orig = ref_run._r.find('{http://schemas.openxmlformats.org/drawingml/2006/main}rPr')
        if rPr_orig is not None:
            rPr = copy.deepcopy(rPr_orig)
            rPr.attrib.pop('b', None)
            r.insert(0, rPr)
    t = etree.SubElement(r, '{http://schemas.openxmlformats.org/drawingml/2006/main}t')
    t.text = text
    if text and (text[0] == ' ' or text[-1] == ' '):
        t.set('{http://www.w3.org/XML/1998/namespace}space', 'preserve')

def replace_shape_with_image(slide, shape, image_path, override_bounds=None, maintain_aspect_ratio=False):
    """
    Replace a shape with an image.
    If maintain_aspect_ratio=True, scale image to fit within bounds while preserving aspect ratio.
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

    sp_element = shape._element
    sp_element.getparent().remove(sp_element)

    if maintain_aspect_ratio:
        # Load image to get dimensions
        try:
            from PIL import Image
            img = Image.open(image_path)
            img_width, img_height = img.size
            aspect_ratio = img_width / img_height if img_height > 0 else 1.0

            # Calculate dimensions to fit within bounds while maintaining aspect ratio
            target_width = width
            target_height = int(target_width / aspect_ratio)

            if target_height > height:
                target_height = height
                target_width = int(target_height * aspect_ratio)

            width = target_width
            height = target_height
        except Exception as e:
            print(f"WARNING: Could not load image for aspect ratio: {e}", file=sys.stderr)

    slide.shapes.add_picture(image_path, left, top, width, height)

def replace_shape_with_multiple_images(slide, shape, image_paths):
    valid_paths = [p for p in image_paths if p and os.path.exists(p)]
    if not valid_paths:
        print("WARNING: No valid images for multi-image replacement", file=sys.stderr)
        return
    left = shape.left
    top = shape.top
    total_width = shape.width
    height = shape.height
    n = len(valid_paths)
    gap = Emu(36000)
    img_width = (total_width - gap * (n - 1)) // n
    sp_element = shape._element
    sp_element.getparent().remove(sp_element)
    for i, img_path in enumerate(valid_paths):
        img_left = left + i * (img_width + gap)
        slide.shapes.add_picture(img_path, img_left, top, img_width, height)

SLIDE_15_GRID_SHAPES = {
    'Google Shape;141;p27', 'Google Shape;145;p27',
    'Google Shape;146;p27', 'Google Shape;147;p27',
    'Google Shape;150;p27', 'Google Shape;151;p27',
    'Google Shape;152;p27', 'Google Shape;153;p27',
}

def _handle_slide_15(slide, chart_paths):
    chart_path = chart_paths.get('tableau_comparative_charts')
    if not chart_path or not os.path.exists(chart_path):
        print("WARNING: No comparatif chart for slide 15", file=sys.stderr)
        return
    shapes_to_remove = []
    for shape in slide.shapes:
        name = shape.name if hasattr(shape, 'name') else ''
        placeholder = get_shape_placeholder(shape)
        if placeholder == '{{tableau comparative_charts}}' or name in SLIDE_15_GRID_SHAPES:
            shapes_to_remove.append(shape)
    for shape in shapes_to_remove:
        sp_element = shape._element
        sp_element.getparent().remove(sp_element)
    # Full width with small margins
    left = Emu(200000)
    top = Emu(391320)
    width = Emu(8700000)
    height = Emu(4400000)
    slide.shapes.add_picture(chart_path, left, top, width, height)

def find_large_shape_for_charts(slide):
    """
    Find the large empty shape on risk chart slides (8, 11, 14).
    Criteria: width > 8 inches, height > 2.5 inches, top < 1.5 inches.
    Returns the first matching shape or None.
    """
    # Emu(914400) = 1 inch
    min_width = Emu(914400 * 8)  # 8 inches
    min_height = Emu(914400 * 2.5)  # 2.5 inches
    max_top = Emu(914400 * 1.5)  # 1.5 inches

    for shape in slide.shapes:
        if not shape.has_text_frame:
            continue
        # Check if shape is mostly empty or has minimal text
        text_content = shape.text_frame.text.strip()
        if len(text_content) > 50:
            continue  # Skip shapes with substantial text

        # Check size and position criteria
        if shape.width >= min_width and shape.height >= min_height and shape.top <= max_top:
            return shape

    return None

def _insert_risk_charts_fallback(slide, slide_num, chart_paths):
    """
    Fallback mechanism for risk chart slides (8, 11, 14).
    Finds the large empty shape at the top and inserts the 3 risk charts there.
    """
    scenario_map = {
        8: 'scenario_A',
        11: 'scenario_B',
        14: 'scenario_C',
    }
    scenario = scenario_map.get(slide_num)
    if not scenario:
        return False

    chart_keys = [f'{scenario}_risk_radar', f'{scenario}_risk_gauge', f'{scenario}_risk_bars']
    chart_image_paths = [chart_paths.get(k) for k in chart_keys]
    chart_image_paths = [p for p in chart_image_paths if p and os.path.exists(p)]

    if not chart_image_paths:
        print(f"WARNING: No risk charts for slide {slide_num}", file=sys.stderr)
        return False

    # Find the large shape
    target_shape = find_large_shape_for_charts(slide)
    if not target_shape:
        print(f"WARNING: No suitable shape found for risk charts on slide {slide_num}", file=sys.stderr)
        return False

    print(f"Found target shape for risk charts on slide {slide_num}: {target_shape.name}", file=sys.stderr)

    # Insert multiple images (3 charts side by side)
    if len(chart_image_paths) == 1:
        replace_shape_with_image(slide, target_shape, chart_image_paths[0])
    else:
        replace_shape_with_multiple_images(slide, target_shape, chart_image_paths)

    return True

def _clean_phasage_text(text):
    """
    Clean up phasage text by removing or minimizing the raw data.
    For slide 18 right column, we skip inserting phasage text entirely
    since a timeline chart will be shown on slide 19.
    """
    if not text:
        return ''
    # For now, return empty string if this is raw phasage data
    # (it will be displayed as a chart on slide 19)
    if 'Phasage:' in text or 'MONOPHASEE' in text or 'TRIPHASEE' in text:
        return ''
    return text

def assemble_pptx(data, template_path, output_path):
    chart_dir = tempfile.mkdtemp(prefix='barlo_charts_')
    print(f"Generating charts in {chart_dir}...", file=sys.stderr)
    chart_paths = generate_all_charts(data, chart_dir)
    print(f"Charts generated: {list(chart_paths.keys())}", file=sys.stderr)
    img_dir = tempfile.mkdtemp(prefix='barlo_images_')
    images = data.get('images', {})
    downloaded_images = {}
    for key, url in images.items():
        if url:
            print(f"Downloading image: {key}...", file=sys.stderr)
            local_path = download_image(url, img_dir)
            if local_path:
                downloaded_images[key] = local_path
    prs = Presentation(template_path)
    texts = data.get('texts', {})
    client_name = data.get('client_name', '')
    if 'slide_3_text' not in texts and 'slide_3_intro_text' in texts:
        parts = [texts.get('slide_3_intro_text', ''), texts.get('slide_3_programme_text', '')]
        texts['slide_3_text'] = '\n\n'.join(p for p in parts if p)
    for base_key in ['invisible_technical_text', 'invisible_financial_text', 'invisible_strategic_text']:
        s17_key = f'{base_key}_s17'
        s18_key = f'{base_key}_s18'
        if s17_key not in texts and base_key in texts:
            texts[s17_key] = texts[base_key]
        if s18_key not in texts:
            success_key = base_key.replace('invisible_', 'success_')
            if success_key in texts:
                texts[s18_key] = texts[success_key]
            elif base_key in texts:
                texts[s18_key] = texts[base_key]
    print(f"Text keys available: {sorted(texts.keys())}", file=sys.stderr)
    print(f"Chart paths available: {sorted(chart_paths.keys())}", file=sys.stderr)

    for slide_idx, slide in enumerate(prs.slides):
        slide_num = slide_idx + 1
        if slide_num == 15:
            _handle_slide_15(slide, chart_paths)
            continue

        # Special handling for risk chart slides with fallback
        if slide_num in RISK_CHART_SLIDES:
            shapes_to_process = list(slide.shapes)
            chart_inserted = False
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if placeholder and placeholder in CHART_PLACEHOLDERS:
                    chart_keys = CHART_PLACEHOLDERS[placeholder]
                    chart_image_paths = [chart_paths.get(k) for k in chart_keys]
                    chart_image_paths = [p for p in chart_image_paths if p]
                    if len(chart_image_paths) == 1:
                        replace_shape_with_image(slide, shape, chart_image_paths[0])
                        chart_inserted = True
                    elif len(chart_image_paths) > 1:
                        replace_shape_with_multiple_images(slide, shape, chart_image_paths)
                        chart_inserted = True
                    break

            # Fallback: if chart placeholder not found by text, search by shape size
            if not chart_inserted:
                print(f"No risk chart placeholder found on slide {slide_num}, using fallback...", file=sys.stderr)
                _insert_risk_charts_fallback(slide, slide_num, chart_paths)

            # Continue processing other shapes (text, etc.)
            shapes_to_process = list(slide.shapes)
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if not placeholder or placeholder in CHART_PLACEHOLDERS:
                    continue

                # Handle other placeholders on risk slides
                if placeholder == '{{client_name}}':
                    replace_text_in_shape(shape, placeholder, client_name)
                    font_size = get_font_size_for_slide(slide_num)
                    set_font_size_for_shape(shape, font_size)
                    enable_auto_shrink(shape)
                    continue

                placeholder_key = placeholder.strip('{}').strip()
                slide_specific_key = (slide_num, placeholder)
                if slide_specific_key in SLIDE_SPECIFIC_TEXT:
                    text_key = SLIDE_SPECIFIC_TEXT[slide_specific_key]
                    text = texts.get(text_key, '')
                    if text:
                        replace_text_in_shape(shape, placeholder, text)
                        font_size = get_font_size_for_slide(slide_num)
                        set_font_size_for_shape(shape, font_size)
                        enable_auto_shrink(shape)
                    else:
                        clear_shape_text(shape)
                    continue

                text = texts.get(placeholder_key, '')
                if text:
                    replace_text_in_shape(shape, placeholder, text)
                    font_size = get_font_size_for_slide(slide_num)
                    set_font_size_for_shape(shape, font_size)
                    enable_auto_shrink(shape)
                else:
                    clean_key = placeholder_key.replace(' ', '_')
                    text = texts.get(clean_key, '')
                    if text:
                        replace_text_in_shape(shape, placeholder, text)
                        font_size = get_font_size_for_slide(slide_num)
                        set_font_size_for_shape(shape, font_size)
                        enable_auto_shrink(shape)
        else:
            # Standard shape processing for non-risk slides
            shapes_to_process = list(slide.shapes)
            for shape in shapes_to_process:
                placeholder = get_shape_placeholder(shape)
                if not placeholder:
                    continue
                placeholder_key = placeholder.strip('{}').strip()
                if placeholder == '{{client_name}}':
                    replace_text_in_shape(shape, placeholder, client_name)
                    font_size = get_font_size_for_slide(slide_num)
                    set_font_size_for_shape(shape, font_size)
                    enable_auto_shrink(shape)
                    continue
                if placeholder in IMAGE_PLACEHOLDERS:
                    img_key = placeholder_key
                    img_path = downloaded_images.get(img_key)
                    if img_path:
                        # Use aspect ratio preservation for massing images
                        maintain_aspect = placeholder in ['{{scenario_A_massing}}', '{{scenario_B_massing}}', '{{scenario_C_massing}}']
                        replace_shape_with_image(slide, shape, img_path, maintain_aspect_ratio=maintain_aspect)
                    else:
                        clear_shape_text(shape)
                    continue
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
                slide_specific_key = (slide_num, placeholder)
                if slide_specific_key in SLIDE_SPECIFIC_TEXT:
                    text_key = SLIDE_SPECIFIC_TEXT[slide_specific_key]
                    text = texts.get(text_key, '')
                    # Special handling for slide 18 phasage text
                    if slide_num == 18 and 'phasage' in text_key.lower():
                        text = _clean_phasage_text(text)
                    if text:
                        replace_text_in_shape(shape, placeholder, text)
                        font_size = get_font_size_for_slide(slide_num)
                        set_font_size_for_shape(shape, font_size)
                        enable_auto_shrink(shape)
                    else:
                        clear_shape_text(shape)
                    continue
                text = texts.get(placeholder_key, '')
                if text:
                    replace_text_in_shape(shape, placeholder, text)
                    font_size = get_font_size_for_slide(slide_num)
                    set_font_size_for_shape(shape, font_size)
                    enable_auto_shrink(shape)
                else:
                    clean_key = placeholder_key.replace(' ', '_')
                    text = texts.get(clean_key, '')
                    if text:
                        replace_text_in_shape(shape, placeholder, text)
                        font_size = get_font_size_for_slide(slide_num)
                        set_font_size_for_shape(shape, font_size)
                        enable_auto_shrink(shape)
                    else:
                        print(f"WARNING: No text for placeholder {placeholder} on slide {slide_num}", file=sys.stderr)

    slides_list = list(prs.slides)

    # Enhanced chart positioning for slides 17, 19, 20
    cost_chart = chart_paths.get('cost_breakdown')
    if cost_chart and os.path.exists(cost_chart) and len(slides_list) >= 17:
        slide17 = slides_list[16]
        # Move down to avoid overlapping text columns (3-column layout)
        slide17.shapes.add_picture(cost_chart, Emu(2500000), Emu(4200000), Emu(4200000), Emu(3000000))
        print("Inserted cost breakdown chart on slide 17", file=sys.stderr)

    timeline_chart = chart_paths.get('timeline')
    if timeline_chart and os.path.exists(timeline_chart) and len(slides_list) >= 19:
        slide19 = slides_list[18]
        # Position after text, use more height
        slide19.shapes.add_picture(timeline_chart, Emu(200000), Emu(3400000), Emu(8700000), Emu(2400000))
        print("Inserted timeline chart on slide 19", file=sys.stderr)

    recap_chart = chart_paths.get('recap_card')
    if recap_chart and os.path.exists(recap_chart) and len(slides_list) >= 20:
        slide20 = slides_list[19]
        # Position at bottom, use more width
        slide20.shapes.add_picture(recap_chart, Emu(200000), Emu(3800000), Emu(8700000), Emu(2400000))
        print("Inserted recap card on slide 20", file=sys.stderr)

    # Apply auto-shrink to text-heavy shapes
    shrink_count = 0
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                text_content = shape.text_frame.text.strip()
                if len(text_content) > 100:
                    enable_auto_shrink(shape, fontScale=62500)
                    shrink_count += 1
    print(f"Auto-shrink applied to {shrink_count} text shapes (fontScale=62500)", file=sys.stderr)

    prs.save(output_path)
    print(f"PPTX saved to {output_path}", file=sys.stderr)
    shutil.rmtree(chart_dir, ignore_errors=True)
    shutil.rmtree(img_dir, ignore_errors=True)
    return output_path

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
