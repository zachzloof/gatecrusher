import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-control text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        /** The single primary action in a view. */
        primary: "bg-accent text-bg hover:bg-accent/90",
        secondary: "border border-border bg-surface-2 text-text hover:bg-surface-1",
        ghost: "text-text-muted hover:bg-surface-2 hover:text-text",
        "danger-ghost": "text-danger hover:bg-surface-2",
      },
      size: {
        default: "h-9 px-3",
        sm: "h-8 px-2.5 text-13",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const classes = cn(buttonVariants({ variant, size }), className);
  if (asChild) return <Slot.Root className={classes} {...props} />;
  return <button type={type ?? "button"} className={classes} {...props} />;
}

export { Button, buttonVariants };
