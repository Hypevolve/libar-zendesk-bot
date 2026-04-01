import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[background-color,color,box-shadow,transform,border-color] duration-200 ease-out disabled:pointer-events-none disabled:opacity-50 outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-soft hover:bg-[hsl(23_90%_51%)] hover:shadow-[0_14px_28px_rgba(244,130,32,0.22)] hover:-translate-y-[1px]",
        secondary:
          "bg-secondary text-secondary-foreground border border-border hover:bg-[hsl(36_44%_92%)]",
        ghost: "text-foreground hover:bg-accent hover:text-accent-foreground"
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-4",
        icon: "h-11 w-11"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
);
Button.displayName = "Button";

export { Button, buttonVariants };
