export function Logo({ size = 32 }: { size?: number }) {
  return (
    <img src={`${import.meta.env.BASE_URL}icon.svg`} width={size} height={size} alt="" draggable={false} className="shrink-0 select-none" />
  );
}
