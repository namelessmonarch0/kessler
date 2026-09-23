export function Card({ className = "", children, ...rest }: React.HTMLAttributes<HTMLElement>) {
  return (
    <section className={`card p-5 ${className}`} {...rest}>
      {children}
    </section>
  );
}
