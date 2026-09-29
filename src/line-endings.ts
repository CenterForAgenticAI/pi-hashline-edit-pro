import type { LineEnding } from "./normalize";

export interface EndingSpan {
	start: number;
	end: number;
	replacementCount: number;
}

export function countNewlines(content: string): number {
	let count = 0;
	for (let index = 0; index < content.length; index++) {
		if (content.charCodeAt(index) === 10) count += 1;
	}
	return count;
}

export function splitSeparators(raw: string): LineEnding[] {
	const separators: LineEnding[] = [];
	for (let index = 0; index < raw.length; index++) {
		const char = raw[index]!;
		if (char === "\r") {
			if (raw[index + 1] === "\n") {
				separators.push("\r\n");
				index += 1;
			} else {
				separators.push("\r");
			}
		} else if (char === "\n") {
			separators.push("\n");
		}
	}
	return separators;
}

export function joinSeparators(content: string, separators: readonly LineEnding[]): string {
	let out = "";
	let separatorIndex = 0;
	for (const char of content) {
		if (char === "\n") {
			out += separators[separatorIndex] ?? "\n";
			separatorIndex += 1;
		} else {
			out += char;
		}
	}
	return out;
}

function sourceLineMap(baseLineCount: number, spans: readonly EndingSpan[]): number[] {
	const sorted = [...spans].sort((left, right) => left.start - right.start);
	const map: number[] = [];
	let baseLine = 0;
	for (const span of sorted) {
		while (baseLine < span.start && baseLine < baseLineCount) {
			map.push(baseLine);
			baseLine += 1;
		}
		const spanLength = span.end >= span.start ? span.end - span.start + 1 : 0;
		for (let offset = 0; offset < span.replacementCount; offset++) {
			if (offset < spanLength) map.push(span.start + offset);
			else map.push(spanLength > 0 ? span.end : span.start - 1);
		}
		baseLine = span.end >= span.start ? span.end + 1 : span.start;
	}
	while (baseLine < baseLineCount) {
		map.push(baseLine);
		baseLine += 1;
	}
	return map;
}

export function separatorsForSpans(
	baseSeparators: readonly LineEnding[],
	baseLineCount: number,
	spans: readonly EndingSpan[],
	resultContent: string,
	fallback: LineEnding,
): LineEnding[] {
	const mapped = sourceLineMap(baseLineCount, spans).map((source) =>
		source >= 0 && source < baseSeparators.length ? baseSeparators[source]! : "",
	);
	const needed = countNewlines(resultContent);
	const result: LineEnding[] = [];
	for (let index = 0; index < needed; index++) {
		const candidate = mapped[index];
		if (candidate !== undefined && candidate !== "") result.push(candidate);
		else result.push(result[index - 1] ?? fallback);
	}
	return result;
}
