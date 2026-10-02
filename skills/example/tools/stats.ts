interface StatsInput {
  text: string;
}

interface StatsOutput {
  characters: number;
  words: number;
  lines: number;
  longestWord: string;
}

export default function stats(input: StatsInput): StatsOutput {
  const text = input.text;
  const words = text.split(/\s+/u).filter((w) => w.length > 0);
  const longestWord = words.reduce((longest, w) => (w.length > longest.length ? w : longest), "");
  return {
    characters: [...text].length,
    words: words.length,
    lines: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
    longestWord,
  };
}
