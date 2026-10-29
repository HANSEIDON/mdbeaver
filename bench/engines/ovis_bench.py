"""OvisOCR2 via offline vLLM, following the model card's reference parser (prompt, greedy decoding,
448²–2880² pixel bounds). Pages are rendered at 200 DPI; image-region tags are dropped as in the card.
"""

from pathlib import Path

import pypdfium2 as pdfium
from vllm import LLM, SamplingParams

from common import Metrics, VramSampler, doc_paths, timer

MODEL = Path.home() / "mdb" / "models" / "OvisOCR2"
DPI = 200
PROMPT = (
    "\nExtract all readable content from the image in natural human reading order and output the result as a "
    "single Markdown document. For charts or images, represent them using an HTML image tag: <"
    'img src="images/bbox_{left}_{top}_{right}_{bottom}.jpg" />, where left, top, right, bottom are bounding box '
    "coordinates scaled to [0, 1000). Format formulas as LaTeX. Format tables as HTML: <table>...</table>. "
    "Transcribe all other text as standard Markdown. Preserve the original text without translation or paraphrasing."
)


def render(pdf: Path):
    doc = pdfium.PdfDocument(str(pdf))
    return [page.render(scale=DPI / 72).to_pil().convert("RGB") for page in doc]


def clean(text: str) -> str:
    return "\n\n".join(b for b in text.strip().split("\n\n") if not b.strip().startswith('<img src="images/bbox_'))


def main():
    metrics = Metrics("ovis")
    with VramSampler() as sampler:
        elapsed = timer()
        llm = LLM(model=str(MODEL), tensor_parallel_size=1, gpu_memory_utilization=0.8, gdn_prefill_backend="triton")
        prompt = llm.get_tokenizer().apply_chat_template(
            [{"role": "user", "content": [{"type": "image"}, {"type": "text", "text": PROMPT}]}],
            tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        params = SamplingParams(max_tokens=16384, temperature=0.0)
        metrics.data["load_s"] = round(elapsed(), 1)

        for doc in doc_paths():
            elapsed = timer()
            images = render(doc)
            inputs = [
                {"prompt": prompt, "multi_modal_data": {"image": img},
                 "mm_processor_kwargs": {"images_kwargs": {"min_pixels": 448 * 448, "max_pixels": 2880 * 2880}}}
                for img in images
            ]
            outputs = llm.generate(inputs, params, use_tqdm=False)
            markdown = "\n\n".join(
                f"<!-- page {i} -->\n\n{clean(o.outputs[0].text)}" for i, o in enumerate(outputs, 1)
            )
            metrics.add(doc, len(images), elapsed(), markdown)
    metrics.save(sampler)


if __name__ == "__main__":
    main()
