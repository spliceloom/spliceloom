interface HelloInput {
  name: string;
  excited?: boolean;
}

interface HelloOutput {
  message: string;
}

export default function hello(input: HelloInput): HelloOutput {
  const name = input.name.trim();
  return { message: `Hello, ${name}${input.excited ? "!" : "."}` };
}
