import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const uuid = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class BreederTaxonSelectionDto {
  @Transform(uuid)
  @IsUUID()
  speciesId: string;

  @Transform(({ value }: { value: unknown }) =>
    Array.isArray(value)
      ? value.map((item: unknown) => uuid({ value: item }))
      : value,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  subspeciesIds: string[];
}

export class RequestBreederTaxaDto {
  @Transform(uuid)
  @IsUUID()
  requestId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsObject({ each: true })
  @ArrayUnique((selection: unknown) =>
    selection && typeof selection === 'object' && 'speciesId' in selection
      ? selection.speciesId
      : selection,
  )
  @ValidateNested({ each: true })
  @Type(() => BreederTaxonSelectionDto)
  selections: BreederTaxonSelectionDto[];
}

export class DecideBreederPermissionDto {
  @Transform(uuid)
  @IsUUID()
  requestId: string;

  @IsInt()
  @Min(1)
  @Max(2147483646)
  expectedRevision: number;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 500)
  reason: string;
}

export enum BreederPermissionKind {
  SPECIES = 'species-permissions',
  SUBSPECIES = 'subspecies-permissions',
}

export enum BreederPermissionDecision {
  APPROVE = 'approve',
  REJECT = 'reject',
  REVOKE = 'revoke',
  REGRANT = 'regrant',
}
